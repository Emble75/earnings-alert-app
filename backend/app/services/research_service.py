"""Manual research: analyse real products without a marketplace API.

Official product APIs are hard to get. Amazon's needs a seller account or an
Associates account with qualifying sales; eBay's needs a developer
registration. Neither is instant, and scraping either site is against their
terms, unreliable, and would feed bad numbers into financial decisions - so
this system does not do it.

This module is the honest middle path. The operator looks up a handful of real
products themselves, enters what they see, and the full engine - matching,
fees, profit, scenarios, risk - runs on those figures. The analysis is exactly
the analysis the automated pipeline performs; only the data collection is
manual.

Prices entered here are *observations*, timestamped at entry, and they age
exactly like provider-sourced ones.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.errors import ValidationError
from app.core.ids import reference
from app.core.money import Money
from app.models.enums import (
    DeliverySpeed,
    ExecutionMode,
    IdentifierType,
    OpportunityState,
    ProductCondition,
    StockStatus,
)
from app.models.market import CompetitionSnapshot, PriceHistory, SourceOffer, TargetListing
from app.models.opportunity import Opportunity
from app.providers.registry import ProviderBundle
from app.services.market_service import MarketService
from app.services.opportunity_service import EvaluationResult, OpportunityService
from app.services.settings_service import BusinessConfig

#: The columns a research CSV may contain. Only a few are required; the rest
#: sharpen the analysis and are defaulted conservatively when absent.
COLUMNS = {
    "required": ["title", "source_price", "target_price"],
    # Not formally required, but without all three of ean, brand and model a
    # match cannot reach the default 95% confidence and the row is rejected.
    "needed_to_pass": ["ean", "brand", "model"],
    "recommended": ["source_stock", "source_delivery_days", "median_competitor_price"],
    "optional": [
        "source_url", "target_url", "source_shipping", "target_shipping",
        "source_quantity_available", "competitor_count", "lowest_competitor_price",
        "median_competitor_price", "highest_competitor_price", "condition", "category", "notes",
    ],
}

CSV_TEMPLATE = (
    "title,ean,brand,model,source_price,source_shipping,source_stock,"
    "source_delivery_days,source_quantity_available,target_price,target_shipping,"
    "competitor_count,lowest_competitor_price,median_competitor_price,"
    "highest_competitor_price,condition,category,source_url,target_url,notes\n"
    "Sony WH-1000XM5 Black,4548736134584,Sony,WH-1000XM5,199.00,0.00,IN_STOCK,2,20,"
    "319.00,0.00,11,309.00,319.00,349.90,NEW,Audio,,,example row - replace me\n"
)


@dataclass
class ResearchInput:
    """One real product, as observed by the operator."""

    title: str
    source_price: Decimal
    target_price: Decimal
    ean: str | None = None
    brand: str | None = None
    model: str | None = None
    source_shipping: Decimal = Decimal("0")
    target_shipping: Decimal = Decimal("0")
    source_stock: StockStatus = StockStatus.UNKNOWN
    source_delivery_days: int | None = None
    source_quantity_available: int | None = None
    competitor_count: int | None = None
    lowest_competitor_price: Decimal | None = None
    median_competitor_price: Decimal | None = None
    highest_competitor_price: Decimal | None = None
    condition: ProductCondition = ProductCondition.NEW
    category: str | None = None
    source_url: str | None = None
    target_url: str | None = None
    notes: str | None = None


@dataclass
class ResearchOutcome:
    created: list[Opportunity] = field(default_factory=list)
    evaluations: list[EvaluationResult] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def summary(self) -> dict:
        actionable = [e for e in self.evaluations if e.is_actionable]
        return {
            "analysed": len(self.evaluations),
            "actionable": len(actionable),
            "rejected": sum(1 for e in self.evaluations if e.opportunity.state.value == "REJECTED"),
            "blocked": sum(1 for e in self.evaluations if e.opportunity.state.value == "BLOCKED"),
            "errors": self.errors,
        }


def _decimal(value: str | None, field_name: str, *, default: Decimal | None = None) -> Decimal:
    if value is None or str(value).strip() == "":
        if default is not None:
            return default
        raise ValidationError(f"{field_name} is required")
    cleaned = (
        str(value).strip().replace("€", "").replace(" ", "").replace(" ", "")
    )
    # A comma reaching this point is a decimal separator: had it been a field
    # separator the CSV reader would already have split on it. "1.319,50" is
    # European formatting, so the dots are thousands separators and go.
    if "," in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    try:
        parsed = Decimal(cleaned)
    except InvalidOperation:
        raise ValidationError(f"{field_name}: {value!r} is not a number") from None
    if parsed < 0:
        raise ValidationError(f"{field_name} cannot be negative")
    return parsed


def _optional_decimal(value: str | None, field_name: str) -> Decimal | None:
    if value is None or str(value).strip() == "":
        return None
    return _decimal(value, field_name)


def _int(value: str | None) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return int(float(str(value).strip()))
    except ValueError:
        return None


def detect_delimiter(content: str) -> str:
    """Work out whether the file is comma, semicolon or tab separated.

    Excel in most of continental Europe exports semicolon-separated files so
    that a comma can be used as the decimal separator. Assuming a comma would
    reject exactly the files a European operator is most likely to produce, so
    the delimiter is detected from the header line rather than assumed.
    """
    header = content.lstrip().splitlines()[0] if content.strip() else ""
    counts = {delimiter: header.count(delimiter) for delimiter in (";", "\t", ",")}
    best = max(counts, key=lambda d: counts[d])
    return best if counts[best] > 0 else ","


def parse_csv(content: str) -> tuple[list[ResearchInput], list[str]]:
    """Parse a research CSV, collecting per-row errors rather than aborting."""
    rows: list[ResearchInput] = []
    errors: list[str] = []
    reader = csv.DictReader(io.StringIO(content), delimiter=detect_delimiter(content))
    if reader.fieldnames is None:
        raise ValidationError("the file is empty or has no header row")

    headers = {(name or "").strip().lower() for name in reader.fieldnames}
    missing = [column for column in COLUMNS["required"] if column not in headers]
    if missing:
        raise ValidationError(
            f"missing required column(s): {', '.join(missing)}. "
            f"Required: {', '.join(COLUMNS['required'])}"
        )

    for number, raw in enumerate(reader, start=2):
        row = {(k or "").strip().lower(): (v.strip() if isinstance(v, str) else v)
               for k, v in raw.items()}
        if not any(row.values()):
            continue
        try:
            title = row.get("title") or ""
            if len(title) < 3:
                raise ValidationError("title is required")
            stock_raw = (row.get("source_stock") or "").upper().replace(" ", "_")
            try:
                stock = StockStatus(stock_raw) if stock_raw else StockStatus.UNKNOWN
            except ValueError:
                stock = StockStatus.UNKNOWN
            condition_raw = (row.get("condition") or "NEW").upper().replace(" ", "_")
            try:
                condition = ProductCondition(condition_raw)
            except ValueError:
                condition = ProductCondition.NEW

            rows.append(
                ResearchInput(
                    title=title,
                    source_price=_decimal(row.get("source_price"), "source_price"),
                    target_price=_decimal(row.get("target_price"), "target_price"),
                    ean=(row.get("ean") or None),
                    brand=(row.get("brand") or None),
                    model=(row.get("model") or None),
                    source_shipping=_decimal(
                        row.get("source_shipping"), "source_shipping", default=Decimal("0")
                    ),
                    target_shipping=_decimal(
                        row.get("target_shipping"), "target_shipping", default=Decimal("0")
                    ),
                    source_stock=stock,
                    source_delivery_days=_int(row.get("source_delivery_days")),
                    source_quantity_available=_int(row.get("source_quantity_available")),
                    competitor_count=_int(row.get("competitor_count")),
                    lowest_competitor_price=_optional_decimal(
                        row.get("lowest_competitor_price"), "lowest_competitor_price"
                    ),
                    median_competitor_price=_optional_decimal(
                        row.get("median_competitor_price"), "median_competitor_price"
                    ),
                    highest_competitor_price=_optional_decimal(
                        row.get("highest_competitor_price"), "highest_competitor_price"
                    ),
                    condition=condition,
                    category=(row.get("category") or None),
                    source_url=(row.get("source_url") or None),
                    target_url=(row.get("target_url") or None),
                    notes=(row.get("notes") or None),
                )
            )
        except ValidationError as exc:
            errors.append(f"row {number}: {exc.message}")
    return rows, errors


class ResearchService:
    """Turns manually observed products into fully analysed opportunities."""

    def __init__(
        self, session: Session, config: BusinessConfig, providers: ProviderBundle
    ) -> None:
        self.session = session
        self.config = config
        self.providers = providers
        self.currency = config.base_currency
        self.market = MarketService(session, currency=self.currency)
        self.opportunities = OpportunityService(session, config, providers)

    def analyse(self, entries: list[ResearchInput]) -> ResearchOutcome:
        outcome = ResearchOutcome()
        for entry in entries:
            try:
                opportunity = self._build(entry)
                outcome.created.append(opportunity)
                evaluation = self.opportunities.evaluate(opportunity)
                self._add_actionable_hint(entry, opportunity)
                outcome.evaluations.append(evaluation)
            except Exception as exc:  # one bad row must not lose the rest
                outcome.errors.append(f"{entry.title[:40]}: {exc}")
        return outcome

    def _add_actionable_hint(self, entry: ResearchInput, opportunity: Opportunity) -> None:
        """Turn a correct-but-opaque rejection into something the operator can fix.

        "match confidence 89 is below the required 95" is accurate and useless.
        The matcher is right to be uncertain - an identifier alone, with no
        brand or model to corroborate it, is not enough evidence - but the
        operator needs to know *which field to add*, not just that a number was
        too low.
        """
        if opportunity.state is not OpportunityState.REJECTED:
            return
        reason = opportunity.rejected_reason or ""
        if "confidence" not in reason:
            return

        missing = [name for name, value in (("EAN", entry.ean), ("brand", entry.brand),
                                            ("model", entry.model)) if not value]
        if missing:
            hint = (
                f"Add the {' and '.join(missing)} for this product and analyse it again. "
                "An identifier on its own is not enough to confirm the Amazon item and "
                "the eBay listing are the same thing, so the match is refused rather "
                "than assumed."
            )
        else:
            hint = (
                "The brand or model you entered did not corroborate the identifier. "
                "Check both against the actual product pages."
            )
        opportunity.rejected_reason = f"{reason}. {hint}"
        opportunity.decision_reasons = [*opportunity.decision_reasons, hint]
        self.session.flush()

    def analyse_csv(self, content: str) -> ResearchOutcome:
        entries, errors = parse_csv(content)
        if not entries:
            raise ValidationError(
                "no usable rows found. " + ("; ".join(errors) if errors else "")
            )
        outcome = self.analyse(entries)
        outcome.errors = errors + outcome.errors
        return outcome

    def _build(self, entry: ResearchInput) -> Opportunity:
        now = utcnow()
        identifiers = {"EAN": entry.ean} if entry.ean else {}

        product = self.market.upsert_product(
            title=entry.title,
            identifiers=identifiers,
            brand=entry.brand,
            manufacturer=entry.brand,
            model=entry.model,
            category=entry.category,
            condition=entry.condition,
            attributes={},
        )

        # Both sides are recorded as observations by the operator, with the
        # same identifiers, so the matcher compares like with like. Without an
        # EAN the match falls back to brand and model, which by design will not
        # reach the 95 threshold - and the analysis says so plainly.
        offer = SourceOffer(
            product_id=product.id,
            provider="manual-research",
            external_id=f"MR-{reference('SRC')}",
            title=entry.title,
            brand=entry.brand,
            manufacturer=entry.brand,
            model=entry.model,
            condition=entry.condition,
            currency=self.currency,
            price=entry.source_price,
            shipping_cost=entry.source_shipping,
            price_timestamp=now,
            stock_status=entry.source_stock,
            available_quantity=entry.source_quantity_available,
            stock_confidence=Decimal("0.8") if entry.source_stock is StockStatus.IN_STOCK else Decimal("0.3"),
            inventory_timestamp=now,
            delivery_min_days=entry.source_delivery_days,
            delivery_max_days=entry.source_delivery_days,
            delivery_speed=_speed(entry.source_delivery_days),
            delivery_timestamp=now,
            url=entry.source_url,
            attributes={},
            raw_payload={"manual": True, "identifiers": identifiers, "notes": entry.notes},
        )
        listing = TargetListing(
            product_id=product.id,
            provider="manual-research",
            external_id=f"MR-{reference('TGT')}",
            title=entry.title,
            brand=entry.brand,
            model=entry.model,
            condition=entry.condition,
            currency=self.currency,
            price=entry.target_price,
            shipping_price=entry.target_shipping,
            price_timestamp=now,
            quantity=1,
            category_id=entry.category,
            url=entry.target_url,
            attributes={},
            raw_payload={"manual": True, "identifiers": identifiers},
        )
        self.session.add_all([offer, listing])
        self.session.flush()

        for entity_type, entity_id, price in (
            ("source_offer", offer.id, entry.source_price),
            ("target_listing", listing.id, entry.target_price),
        ):
            self.session.add(
                PriceHistory(
                    product_id=product.id,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    provider="manual-research",
                    currency=self.currency,
                    price=price,
                    observed_at=now,
                )
            )

        # Competition, when supplied. The realistic achievable price is the
        # median where known - never the highest observed listing.
        realistic = entry.median_competitor_price or entry.target_price
        self.session.add(
            CompetitionSnapshot(
                product_id=product.id,
                provider="manual-research",
                currency=self.currency,
                competitor_count=entry.competitor_count or 0,
                seller_count=entry.competitor_count or 0,
                lowest_price=entry.lowest_competitor_price,
                median_price=entry.median_competitor_price,
                highest_price=entry.highest_competitor_price,
                realistic_sale_price=realistic,
                observed_at=now,
            )
        )
        self.session.flush()

        opportunity = Opportunity(
            reference=reference("RES"),
            product_id=product.id,
            source_offer_id=offer.id,
            target_listing_id=listing.id,
            state=OpportunityState.DISCOVERED,
            execution_mode=ExecutionMode.RESEARCH
            if self.providers.is_read_only
            else self.providers.execution_mode,
            currency=self.currency,
            quantity=1,
            discovery_source="manual-research",
            notes=entry.notes,
            expires_at=now + timedelta(seconds=self.config.max_opportunity_age_seconds),
        )
        self.session.add(opportunity)
        self.session.flush()
        return opportunity


def _speed(days: int | None) -> DeliverySpeed:
    if days is None:
        return DeliverySpeed.UNKNOWN
    if days <= 1:
        return DeliverySpeed.EXPRESS
    if days <= 3:
        return DeliverySpeed.FAST
    if days <= 6:
        return DeliverySpeed.STANDARD
    return DeliverySpeed.SLOW


def identifier_types() -> list[str]:
    return [t.value for t in IdentifierType]


def money(value: Decimal, currency: str = "EUR") -> Money:
    return Money(value, currency)
