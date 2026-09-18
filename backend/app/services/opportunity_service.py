"""The opportunity engine.

Discovery -> matching -> pricing -> profit -> risk -> decision, with an
explicit state transition and an audit row at every step.

The filter order matters and is deliberate: cheap, decisive checks run first
(is it the same product? is it in stock? can it arrive in time?) before any
money arithmetic, and the profit test runs before the risk test so that a
rejected opportunity carries the most useful reason.

A price gap is never sufficient. An opportunity becomes ACTIONABLE only when
the match is verified, the source has it, delivery is feasible, every cost is
accounted for, profit and margin clear their floors, risk is inside its limit
and compliance passes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.compliance.rules import ComplianceContext
from app.compliance.service import ComplianceService
from app.core.clock import age_seconds, utcnow
from app.core.errors import NotFoundError
from app.core.ids import reference
from app.core.money import Money
from app.matching.matcher import MatchCandidate, MatchResult, match_products, meets_confidence
from app.models.enums import (
    ComplianceCheckType,
    DecisionOutcome,
    ExecutionMode,
    MatchStatus,
    OpportunityState,
    ProductCondition,
    ScenarioType,
    StockStatus,
)
from app.models.market import SourceOffer, TargetListing
from app.models.opportunity import Opportunity, ProfitCalculation, RiskAssessment
from app.models.product import Product, ProductMatch
from app.profit.engine import ProfitBreakdown, inputs_from_config
from app.profit.scenarios import ScenarioSet, build_scenarios
from app.providers.registry import ProviderBundle
from app.risk.engine import RISK_MODEL_VERSION, RiskAssessmentResult, assess_risk, risk_reserve_for
from app.risk.factors import RiskInputs
from app.services.audit_service import AuditService
from app.services.market_service import MarketService
from app.services.settings_service import BusinessConfig
from app.state_machines.opportunity import OPPORTUNITY_MACHINE


@dataclass
class EvaluationResult:
    opportunity: Opportunity
    match: MatchResult | None
    scenarios: ScenarioSet | None
    risk: RiskAssessmentResult | None
    decision: DecisionOutcome
    reasons: list[str]

    @property
    def is_actionable(self) -> bool:
        return self.opportunity.state is OpportunityState.ACTIONABLE


class OpportunityService:
    def __init__(
        self,
        session: Session,
        config: BusinessConfig,
        providers: ProviderBundle,
    ) -> None:
        self.session = session
        self.config = config
        self.providers = providers
        self.currency = config.base_currency
        self.market = MarketService(session, currency=self.currency)
        self.audit = AuditService(session)
        self.compliance = ComplianceService(session)

    # -- state --------------------------------------------------------------
    def transition(
        self,
        opportunity: Opportunity,
        target: OpportunityState,
        *,
        reason: str = "",
        actor: str = "system",
        actor_user_id: int | None = None,
    ) -> Opportunity:
        if opportunity.state is target:
            return opportunity
        OPPORTUNITY_MACHINE.validate(opportunity.state, target)
        previous = opportunity.state
        opportunity.state = target
        self.session.flush()
        self.audit.record(
            "opportunity.transition",
            entity_type="opportunity",
            entity_id=opportunity.id,
            actor=actor,
            actor_user_id=actor_user_id,
            old_state=previous.value,
            new_state=target.value,
            meta={"reason": reason, "reference": opportunity.reference},
        )
        return opportunity

    # -- discovery ----------------------------------------------------------
    def discover(self, query: str, *, limit: int = 20) -> list[Opportunity]:
        """Find source offers, pair them with target listings, create candidates."""
        offers = self.providers.source.search(query, limit=limit)
        created: list[Opportunity] = []

        for offer_snapshot in offers:
            ean = offer_snapshot.identifiers.get("EAN")
            product = self.market.upsert_product(
                title=offer_snapshot.title,
                identifiers=offer_snapshot.identifiers,
                brand=offer_snapshot.brand,
                manufacturer=offer_snapshot.manufacturer,
                model=offer_snapshot.model,
                condition=offer_snapshot.condition,
                attributes=offer_snapshot.attributes,
            )
            offer = self.market.upsert_source_offer(
                offer_snapshot, provider=self.providers.source.name, product=product
            )

            listings = (
                self.providers.target.find_by_identifier("EAN", ean)
                if ean
                else self.providers.target.search_listings(offer_snapshot.title, limit=5)
            )
            if not listings:
                continue
            listing_snapshot = listings[0]
            listing = self.market.upsert_target_listing(
                listing_snapshot, provider=self.providers.target.name, product=product
            )
            stats = self.providers.target.get_market_stats(
                identifier=ean, query=offer_snapshot.title
            )
            self.market.record_market_stats(
                stats, provider=self.providers.target.name, product=product
            )

            opportunity = self._get_or_create(product, offer, listing)
            created.append(opportunity)

        return created

    def _get_or_create(
        self, product: Product, offer: SourceOffer, listing: TargetListing
    ) -> Opportunity:
        stmt = select(Opportunity).where(
            Opportunity.source_offer_id == offer.id,
            Opportunity.target_listing_id == listing.id,
            Opportunity.state.not_in(
                [
                    OpportunityState.COMPLETED.value,
                    OpportunityState.REJECTED.value,
                    OpportunityState.EXPIRED.value,
                    OpportunityState.CANCELLED.value,
                    OpportunityState.FAILED.value,
                ]
            ),
        )
        existing = self.session.execute(stmt).scalars().first()
        if existing is not None:
            return existing

        opportunity = Opportunity(
            reference=reference("OPP"),
            product_id=product.id,
            source_offer_id=offer.id,
            target_listing_id=listing.id,
            state=OpportunityState.DISCOVERED,
            execution_mode=self.providers.execution_mode,
            currency=self.currency,
            quantity=1,
            discovery_source=self.providers.source.name,
            expires_at=utcnow() + timedelta(seconds=self.config.max_opportunity_age_seconds),
        )
        self.session.add(opportunity)
        self.session.flush()
        self.audit.record(
            "opportunity.discovered",
            entity_type="opportunity",
            entity_id=opportunity.id,
            new_state=OpportunityState.DISCOVERED.value,
            meta={"product_id": product.id, "offer_id": offer.id, "listing_id": listing.id},
        )
        return opportunity

    # -- evaluation ---------------------------------------------------------
    def evaluate(self, opportunity: Opportunity) -> EvaluationResult:
        """Run the full decision pipeline for one opportunity."""
        offer = self.session.get(SourceOffer, opportunity.source_offer_id)
        listing = self.session.get(TargetListing, opportunity.target_listing_id)
        product = self.session.get(Product, opportunity.product_id)
        if offer is None or listing is None:
            raise NotFoundError(
                "opportunity is missing its source offer or target listing",
                context={"opportunity": opportunity.reference},
            )

        reasons: list[str] = []
        now = utcnow()

        # 1. Matching ------------------------------------------------------
        if opportunity.state is OpportunityState.DISCOVERED:
            self.transition(opportunity, OpportunityState.MATCH_PENDING, reason="matching")

        match = self.match_offer_to_listing(offer, listing)
        opportunity.match_confidence = match.confidence
        opportunity.match_timestamp = now
        self._persist_match(opportunity, offer, listing, match)

        if match.status is MatchStatus.BLOCKED:
            opportunity.blocked_reason = match.blocked_reason
            opportunity.decision = DecisionOutcome.BLOCK
            reasons.append(f"match blocked: {match.blocked_reason}")
            opportunity.decision_reasons = reasons
            self.transition(opportunity, OpportunityState.BLOCKED, reason=match.blocked_reason or "")
            return EvaluationResult(opportunity, match, None, None, DecisionOutcome.BLOCK, reasons)

        if not meets_confidence(match, self.config.minimum_match_confidence):
            reasons.append(
                f"match confidence {match.confidence} ({match.status.value}) is below the "
                f"required {self.config.minimum_match_confidence}"
            )
            opportunity.decision = DecisionOutcome.REJECT
            opportunity.rejected_reason = reasons[-1]
            opportunity.decision_reasons = reasons
            self.transition(opportunity, OpportunityState.REJECTED, reason=reasons[-1])
            return EvaluationResult(opportunity, match, None, None, DecisionOutcome.REJECT, reasons)

        if opportunity.state is OpportunityState.MATCH_PENDING:
            self.transition(opportunity, OpportunityState.MATCH_VERIFIED, reason="match verified")

        # 2. Pricing -------------------------------------------------------
        if opportunity.state is OpportunityState.MATCH_VERIFIED:
            self.transition(opportunity, OpportunityState.PRICE_PENDING, reason="pricing")

        competition = self.market.latest_competition(opportunity.product_id)
        sale_price = self._achievable_sale_price(listing, competition)
        if offer.stock_status is StockStatus.OUT_OF_STOCK:
            reasons.append("source offer is out of stock")
            opportunity.decision = DecisionOutcome.BLOCK
            opportunity.blocked_reason = reasons[-1]
            opportunity.decision_reasons = reasons
            self.transition(opportunity, OpportunityState.BLOCKED, reason=reasons[-1])
            return EvaluationResult(opportunity, match, None, None, DecisionOutcome.BLOCK, reasons)
        if sale_price is None or offer.price is None:
            reasons.append("no usable price on one side; refusing to guess")
            opportunity.decision = DecisionOutcome.BLOCK
            opportunity.blocked_reason = reasons[-1]
            opportunity.decision_reasons = reasons
            self.transition(opportunity, OpportunityState.BLOCKED, reason=reasons[-1])
            return EvaluationResult(opportunity, match, None, None, DecisionOutcome.BLOCK, reasons)

        source_price = Money(offer.price, self.currency)
        opportunity.source_price = source_price.amount
        opportunity.target_price = sale_price.amount
        opportunity.source_price_timestamp = offer.price_timestamp
        opportunity.target_price_timestamp = listing.price_timestamp
        opportunity.inventory_timestamp = offer.inventory_timestamp
        opportunity.delivery_timestamp = offer.delivery_timestamp

        scenarios = self._calculate(opportunity, offer, sale_price, source_price)
        base = scenarios.base_case

        # 3. Risk ----------------------------------------------------------
        risk = self.assess_risk_for(opportunity, offer, listing, match, base, competition)
        opportunity.risk_score = risk.score
        opportunity.risk_level = risk.level
        opportunity.risk_timestamp = now

        # Re-price with the risk-scaled reserve so the stored profit is the
        # one the operator will actually be shown.
        scenarios = self._calculate(
            opportunity,
            offer,
            sale_price,
            source_price,
            risk_reserve=risk_reserve_for(risk, sale_price, self.config.risk_reserve_percent),
        )
        base = scenarios.base_case
        self._persist_calculations(opportunity, scenarios)
        self._persist_risk(opportunity, risk, base)

        opportunity.expected_net_profit = base.net_profit.amount
        opportunity.worst_case_net_profit = scenarios.worst_case.net_profit.amount
        opportunity.best_case_net_profit = scenarios.best_case.net_profit.amount
        opportunity.total_costs = base.total_costs.amount
        opportunity.profit_margin = base.profit_margin
        opportunity.roi = base.roi
        opportunity.capital_required = base.capital_required.amount
        opportunity.profit_calculation_timestamp = now

        # 4a. Hard blockers ------------------------------------------------
        # Blockers are resolved before the economics are argued about: an
        # opportunity we cannot supply, cannot deliver in time or cannot trust
        # the price of is not a cheap opportunity, it is not an opportunity.
        if risk.is_blocking:
            opportunity.decision = DecisionOutcome.BLOCK
            opportunity.blocked_reason = "; ".join(risk.blockers)
            opportunity.decision_reasons = risk.blockers
            self.transition(opportunity, OpportunityState.BLOCKED, reason=risk.blockers[0])
            return EvaluationResult(
                opportunity, match, scenarios, risk, DecisionOutcome.BLOCK, risk.blockers
            )

        # 4b. Profitability filters ----------------------------------------
        minimum_profit = Money(self.config.minimum_net_profit, self.currency)
        if base.net_profit < minimum_profit:
            reasons.append(
                f"expected net profit {base.net_profit} is below the minimum {minimum_profit}"
            )
        if base.profit_margin is None or base.profit_margin < self.config.minimum_profit_margin:
            reasons.append(
                f"margin {base.profit_margin} is below the minimum {self.config.minimum_profit_margin}"
            )
        if reasons:
            opportunity.decision = DecisionOutcome.REJECT
            opportunity.rejected_reason = "; ".join(reasons)
            opportunity.decision_reasons = reasons
            self.transition(opportunity, OpportunityState.REJECTED, reason=reasons[0])
            return EvaluationResult(opportunity, match, scenarios, risk, DecisionOutcome.REJECT, reasons)

        if opportunity.state is OpportunityState.PRICE_PENDING:
            self.transition(opportunity, OpportunityState.PROFITABLE, reason="profit thresholds met")

        # 5. Risk gate -----------------------------------------------------
        self.transition(opportunity, OpportunityState.RISK_REVIEW, reason="risk scoring")
        if risk.score > self.config.maximum_risk_score:
            reason = f"risk score {risk.score} exceeds the maximum {self.config.maximum_risk_score}"
            opportunity.decision = DecisionOutcome.REJECT
            opportunity.rejected_reason = reason
            opportunity.decision_reasons = [reason, *risk.reasons()[:3]]
            self.transition(opportunity, OpportunityState.REJECTED, reason=reason)
            return EvaluationResult(opportunity, match, scenarios, risk, DecisionOutcome.REJECT, [reason])

        # 6. Compliance ----------------------------------------------------
        compliance = self.compliance.check(
            ComplianceCheckType.LISTING,
            ComplianceContext(
                title=listing.title,
                condition=listing.condition,
                declared_condition_matches_source=(listing.condition is offer.condition),
                identifiers={
                    i.identifier_type.value: i.value for i in (product.identifiers if product else [])
                },
                category=listing.category_id,
                price=sale_price.amount,
                match_is_verified=True,
                handling_time_days=self.config.target_handling_time_days,
                automation_level=self.config.automation_level,
            ),
            entity_type="opportunity",
            entity_id=opportunity.id,
        )
        if compliance.is_blocking:
            opportunity.decision = DecisionOutcome.BLOCK
            opportunity.blocked_reason = compliance.blocked_reason()
            opportunity.decision_reasons = [compliance.blocked_reason() or "compliance blocked"]
            self.transition(opportunity, OpportunityState.BLOCKED, reason="compliance")
            return EvaluationResult(
                opportunity, match, scenarios, risk, DecisionOutcome.BLOCK, opportunity.decision_reasons
            )

        # 7. Actionable -----------------------------------------------------
        opportunity.decision = DecisionOutcome.PASS
        opportunity.decision_reasons = [
            f"net profit {base.net_profit} >= {minimum_profit}",
            f"margin {base.profit_margin} >= {self.config.minimum_profit_margin}",
            f"risk {risk.score} <= {self.config.maximum_risk_score}",
            f"match confidence {match.confidence} >= {self.config.minimum_match_confidence}",
        ]
        opportunity.last_revalidated_at = now
        self.transition(opportunity, OpportunityState.ACTIONABLE, reason="all gates passed")
        return EvaluationResult(
            opportunity, match, scenarios, risk, DecisionOutcome.PASS, opportunity.decision_reasons
        )

    # -- helpers ------------------------------------------------------------
    def match_offer_to_listing(self, offer: SourceOffer, listing: TargetListing) -> MatchResult:
        source_ids = dict(offer.raw_payload.get("identifiers") or {}) or self._identifiers_from_offer(
            offer
        )
        return match_products(
            MatchCandidate(
                title=offer.title,
                identifiers=source_ids,
                brand=offer.brand,
                manufacturer=offer.manufacturer,
                model=offer.model,
                condition=offer.condition,
                attributes=dict(offer.attributes),
                label="source",
            ),
            MatchCandidate(
                title=listing.title,
                identifiers=self._identifiers_from_listing(listing),
                brand=listing.brand,
                model=listing.model,
                condition=listing.condition,
                attributes=dict(listing.attributes),
                label="target",
            ),
            block_on_variant_mismatch=self.config.block_on_variant_mismatch,
        )

    def _identifiers_from_offer(self, offer: SourceOffer) -> dict[str, str]:
        product = self.session.get(Product, offer.product_id) if offer.product_id else None
        if product is None:
            return {}
        return {i.identifier_type.value: i.value for i in product.identifiers}

    def _identifiers_from_listing(self, listing: TargetListing) -> dict[str, str]:
        raw = listing.raw_payload.get("identifiers")
        if raw:
            return dict(raw)
        product = self.session.get(Product, listing.product_id) if listing.product_id else None
        if product is None:
            return {}
        return {i.identifier_type.value: i.value for i in product.identifiers}

    def _persist_match(
        self, opportunity: Opportunity, offer: SourceOffer, listing: TargetListing, match: MatchResult
    ) -> ProductMatch:
        stmt = select(ProductMatch).where(
            ProductMatch.source_offer_id == offer.id, ProductMatch.target_listing_id == listing.id
        )
        row = self.session.execute(stmt).scalars().first()
        if row is None:
            row = ProductMatch(source_offer_id=offer.id, target_listing_id=listing.id)
            self.session.add(row)
        row.product_id = opportunity.product_id
        row.status = match.status
        row.method = match.method
        row.confidence = match.confidence
        row.evidence = match.evidence
        row.conflicts = match.conflicts
        row.blocked_reason = match.blocked_reason
        row.matcher_version = match.matcher_version
        row.match_timestamp = utcnow()
        row.quantity_ratio = match.quantity_ratio
        self.session.flush()
        opportunity.product_match_id = row.id
        return row

    def _achievable_sale_price(self, listing: TargetListing, competition) -> Money | None:
        """What we can realistically sell at.

        Never the highest observed price: that number is usually one optimistic
        seller who has not sold anything. Prefer the provider's realistic
        price, then the median, and only then our own observed listing price.
        """
        if competition is not None and competition.realistic_sale_price is not None:
            return Money(competition.realistic_sale_price, self.currency)
        if competition is not None and competition.median_price is not None:
            return Money(competition.median_price, self.currency)
        if listing.price is not None:
            return Money(listing.price, self.currency)
        return None

    def _calculate(
        self,
        opportunity: Opportunity,
        offer: SourceOffer,
        sale_price: Money,
        source_price: Money,
        *,
        risk_reserve: Money | None = None,
    ) -> ScenarioSet:
        inputs = inputs_from_config(
            self.config,
            sale_price=sale_price,
            source_unit_price=source_price,
            quantity=opportunity.quantity,
            source_shipping_cost=Money(offer.shipping_cost or Decimal("0"), self.currency),
        )
        if risk_reserve is not None:
            from dataclasses import replace

            inputs = replace(inputs, risk_reserve_override=risk_reserve)
        return build_scenarios(inputs, self.config)

    def assess_risk_for(
        self,
        opportunity: Opportunity,
        offer: SourceOffer,
        listing: TargetListing,
        match: MatchResult,
        base: ProfitBreakdown,
        competition,
    ) -> RiskAssessmentResult:
        anomaly_ratio = None
        if offer.price and offer.price > 0 and opportunity.target_price:
            anomaly_ratio = (Decimal(opportunity.target_price) / Decimal(offer.price)).quantize(
                Decimal("0.01")
            )

        from app.services.capital_service import CapitalService

        capital = CapitalService(self.session, self.config)
        inputs = RiskInputs(
            match_status=match.status,
            match_confidence=match.confidence,
            minimum_match_confidence=self.config.minimum_match_confidence,
            source_price_age_seconds=age_seconds(offer.price_timestamp),
            max_price_age_seconds=self.config.max_price_age_seconds,
            source_price_change_percent=self.market.source_price_change_percent(offer),
            stock_status=offer.stock_status,
            stock_confidence=offer.stock_confidence,
            available_quantity=offer.available_quantity,
            required_quantity=opportunity.quantity,
            inventory_age_seconds=age_seconds(offer.inventory_timestamp),
            max_inventory_age_seconds=self.config.max_inventory_age_seconds,
            stock_flapped_recently=self.market.stock_flapped(offer),
            source_delivery_min_days=offer.delivery_min_days,
            source_delivery_max_days=offer.delivery_max_days,
            source_delivery_speed=offer.delivery_speed,
            delivery_age_seconds=age_seconds(offer.delivery_timestamp),
            max_delivery_age_seconds=self.config.max_delivery_age_seconds,
            handling_time_days=self.config.target_handling_time_days,
            target_delivery_expectation_days=self.config.target_delivery_expectation_days,
            max_source_delivery_days=self.config.max_source_delivery_days,
            target_price_age_seconds=age_seconds(listing.price_timestamp),
            observed_target_price=listing.price,
            realistic_target_price=(
                competition.realistic_sale_price if competition is not None else None
            ),
            median_target_price=competition.median_price if competition is not None else None,
            price_volatility=(
                competition.price_volatility
                if competition is not None and competition.price_volatility is not None
                else self.market.volatility(opportunity.product_id)
            ),
            price_history_points=len(self.market.price_points(opportunity.product_id, "target_listing")),
            min_price_history_points=self.config.min_price_history_points,
            price_anomaly_ratio=anomaly_ratio,
            max_price_anomaly_ratio=self.config.price_anomaly_ratio,
            competitor_count=competition.competitor_count if competition is not None else None,
            seller_count=competition.seller_count if competition is not None else None,
            price_spread_ratio=competition.price_spread_ratio if competition is not None else None,
            expected_return_rate=self.config.expected_return_rate,
            fulfillment_is_manual=self.providers.fulfillment.mode.value == "MANUAL",
            capital_required=base.capital_required.amount,
            max_capital_per_order=self.config.max_capital_per_order,
            current_exposure=capital.current_exposure(),
            max_capital_exposure=self.config.max_capital_exposure,
            compliance_outcome=DecisionOutcome.PASS,
            provider_degraded=False,
            is_simulated=self.providers.execution_mode is not ExecutionMode.LIVE,
            block_on_unknown_inventory=self.config.block_on_unknown_inventory,
            block_on_unknown_delivery=self.config.block_on_unknown_delivery,
        )
        return assess_risk(inputs)

    def _persist_calculations(self, opportunity: Opportunity, scenarios: ScenarioSet) -> None:
        now = utcnow()
        for scenario_type, breakdown in (
            (ScenarioType.BEST_CASE, scenarios.best_case),
            (ScenarioType.BASE_CASE, scenarios.base_case),
            (ScenarioType.WORST_CASE, scenarios.worst_case),
        ):
            self.session.add(
                ProfitCalculation(
                    opportunity_id=opportunity.id,
                    scenario=scenario_type,
                    currency=breakdown.currency,
                    quantity=breakdown.quantity,
                    sale_revenue=breakdown.sale_revenue.amount,
                    buyer_shipping_paid=breakdown.buyer_shipping_paid.amount,
                    source_purchase_cost=breakdown.source_purchase_cost.amount,
                    source_shipping_cost=breakdown.source_shipping_cost.amount,
                    marketplace_fees=breakdown.marketplace_fees.amount,
                    payment_fees=breakdown.payment_fees.amount,
                    fulfillment_cost=breakdown.fulfillment_cost.amount,
                    outbound_shipping_cost=breakdown.outbound_shipping_cost.amount,
                    packaging_cost=breakdown.packaging_cost.amount,
                    expected_return_cost=breakdown.expected_return_cost.amount,
                    risk_reserve=breakdown.risk_reserve.amount,
                    other_variable_costs=breakdown.other_variable_costs.amount,
                    total_costs=breakdown.total_costs.amount,
                    net_profit=breakdown.net_profit.amount,
                    profit_margin=breakdown.profit_margin,
                    roi=breakdown.roi,
                    capital_required=breakdown.capital_required.amount,
                    inputs=breakdown.to_dict(),
                    fee_breakdown=breakdown.fee_lines,
                    assumptions=(
                        breakdown.assumptions + scenarios.deltas.get(scenario_type.value.lower(), [])
                    ),
                    profit_model_version=breakdown.profit_model_version,
                    fee_model_version=breakdown.fee_model_version,
                    calculated_at=now,
                )
            )
        self.session.flush()

    def _persist_risk(
        self, opportunity: Opportunity, risk: RiskAssessmentResult, base: ProfitBreakdown
    ) -> RiskAssessment:
        row = RiskAssessment(
            opportunity_id=opportunity.id,
            score=risk.score,
            level=risk.level,
            factors=[f.to_dict() for f in risk.factors],
            blockers=risk.blockers,
            reasons=risk.reasons(),
            inputs={"capital_required": str(base.capital_required.amount)},
            risk_reserve_amount=base.risk_reserve.amount,
            risk_model_version=RISK_MODEL_VERSION,
            is_blocking=risk.is_blocking,
            assessed_at=utcnow(),
        )
        self.session.add(row)
        self.session.flush()
        return row

    # -- freshness / revalidation ------------------------------------------
    def staleness(self, opportunity: Opportunity) -> list[str]:
        """Which inputs are too old to commit money against."""
        checks = (
            ("source price", opportunity.source_price_timestamp, self.config.max_price_age_seconds),
            ("target price", opportunity.target_price_timestamp, self.config.max_price_age_seconds),
            ("inventory", opportunity.inventory_timestamp, self.config.max_inventory_age_seconds),
            ("delivery", opportunity.delivery_timestamp, self.config.max_delivery_age_seconds),
        )
        stale: list[str] = []
        for label, timestamp, limit in checks:
            age = age_seconds(timestamp)
            if age is None:
                stale.append(f"{label} has never been observed")
            elif age > limit:
                stale.append(f"{label} is {int(age)}s old (limit {limit}s)")
        return stale

    def refresh_market_data(self, opportunity: Opportunity) -> None:
        """Pull fresh source and target data before a decision that costs money."""
        offer = self.session.get(SourceOffer, opportunity.source_offer_id)
        listing = self.session.get(TargetListing, opportunity.target_listing_id)
        product = self.session.get(Product, opportunity.product_id)
        if offer is None:
            return
        snapshot = self.providers.source.get_offer(offer.external_id)
        if snapshot is not None:
            self.market.upsert_source_offer(
                snapshot, provider=self.providers.source.name, product=product
            )
        if listing is not None and listing.external_id and not listing.is_own_listing:
            fresh = self.providers.target.get_listing_status(listing.external_id)
            if fresh is not None:
                self.market.upsert_target_listing(
                    fresh, provider=self.providers.target.name, product=product
                )
        ean = (
            product.primary_identifier_value
            if product and product.primary_identifier_value
            else None
        )
        stats = self.providers.target.get_market_stats(
            identifier=ean, query=listing.title if listing else None
        )
        self.market.record_market_stats(stats, provider=self.providers.target.name, product=product)
        self.session.flush()

    def revalidate(self, opportunity: Opportunity) -> EvaluationResult:
        """Refresh every input and re-run the pipeline.

        Called before listing, before approval and before purchase. Old data
        never gets to trigger an irreversible financial action.
        """
        self.refresh_market_data(opportunity)
        opportunity.last_revalidated_at = utcnow()
        self.audit.record(
            "opportunity.revalidated",
            entity_type="opportunity",
            entity_id=opportunity.id,
            meta={"state": opportunity.state.value},
        )
        return self.evaluate(opportunity)

    def expire_stale(self) -> int:
        """Expire opportunities past their maximum age."""
        stmt = select(Opportunity).where(
            Opportunity.expires_at.is_not(None),
            Opportunity.expires_at < utcnow(),
            Opportunity.state.in_(
                [
                    OpportunityState.DISCOVERED.value,
                    OpportunityState.MATCH_PENDING.value,
                    OpportunityState.MATCH_VERIFIED.value,
                    OpportunityState.PRICE_PENDING.value,
                    OpportunityState.PROFITABLE.value,
                    OpportunityState.RISK_REVIEW.value,
                    OpportunityState.ACTIONABLE.value,
                    OpportunityState.LISTING_CANDIDATE.value,
                ]
            ),
        )
        expired = 0
        for opportunity in self.session.execute(stmt).scalars():
            self.transition(opportunity, OpportunityState.EXPIRED, reason="maximum age exceeded")
            expired += 1
        return expired


def condition_matches(source: ProductCondition, target: ProductCondition) -> bool:
    return source is target and source is not ProductCondition.UNKNOWN


def stock_is_usable(status: StockStatus) -> bool:
    return status in (StockStatus.IN_STOCK, StockStatus.LOW_STOCK)
