/**
 * API types.
 *
 * Every monetary value arrives as a decimal string and stays a string in the
 * frontend. Parsing it into a JavaScript number would reintroduce exactly the
 * floating-point imprecision the backend goes out of its way to avoid, so the
 * formatting helpers in lib/format.ts work on strings.
 */

export type OpportunityState =
  | "DISCOVERED" | "MATCH_PENDING" | "MATCH_VERIFIED" | "PRICE_PENDING"
  | "PROFITABLE" | "RISK_REVIEW" | "ACTIONABLE" | "LISTING_CANDIDATE"
  | "LISTED" | "SALE_RECEIVED" | "REVALIDATION_REQUIRED" | "APPROVAL_REQUIRED"
  | "APPROVED" | "EXECUTING" | "FULFILLMENT_PENDING" | "FULFILLED"
  | "COMPLETED" | "REJECTED" | "EXPIRED" | "FAILED" | "CANCELLED" | "BLOCKED";

export type OrderState =
  | "SALE_RECEIVED" | "VALIDATING" | "REVALIDATION_REQUIRED" | "APPROVAL_REQUIRED"
  | "APPROVED" | "SOURCE_PURCHASE_PENDING" | "SOURCE_PURCHASED" | "SOURCE_SHIPPING"
  | "SOURCE_RECEIVED" | "INSPECTION" | "FULFILLMENT" | "OUTBOUND_SHIPPING"
  | "SHIPPED" | "DELIVERED" | "RETURN_REQUESTED" | "RETURNED" | "COMPLETED"
  | "FAILED" | "CANCELLED" | "BLOCKED";

export type RiskLevel = "LOW" | "MODERATE" | "ELEVATED" | "HIGH" | "CRITICAL";
export type ShipmentState =
  | "PENDING" | "LABEL_CREATED" | "SHIPPED" | "IN_TRANSIT" | "OUT_FOR_DELIVERY"
  | "DELIVERED" | "EXCEPTION" | "LOST" | "RETURNED";

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface EbayListing {
  item_id: string;
  title: string;
  price: string | null;
  shipping: string | null;
  total: string | null;
  currency: string;
  condition: string;
  url: string | null;
  seller: string | null;
  seller_feedback: string | null;
  identifiers: Record<string, string>;
  has_identifier: boolean;
}

export interface EbaySearchResponse {
  available: boolean;
  reason: string | null;
  query: string;
  listings: EbayListing[];
}

/** A product found on eBay, with the price that would make it work. */
export interface Candidate {
  title: string;
  ebay_price: string;
  listing_count: number;
  lowest: string;
  highest: string;
  item_id: string;
  item_url: string;
  sold_url: string | null;
  amazon_search_url: string | null;
  ean: string | null;
  brand: string | null;
  model: string | null;
  max_amazon_price: string | null;
  impossible_reason: string | null;
  headroom_percent: string | null;
}

export interface ScanResponse {
  available: boolean;
  listings_seen: number;
  products_found: number;
  detail_lookups: number;
  candidates: Candidate[];
  notes: string[];
}

export interface MarketplaceLinks {
  source_product: string | null;
  target_product: string | null;
  source_search: string | null;
  target_search: string | null;
  target_sold: string | null;
}

export interface ProductSummary {
  id: number;
  title: string;
  brand: string | null;
  manufacturer: string | null;
  model: string | null;
  category: string | null;
  condition: string;
  primary_identifier_value: string | null;
  image_urls: string[];
}

export interface SourceOfferSummary {
  id: number;
  provider: string;
  title: string;
  brand: string | null;
  model: string | null;
  price: string | null;
  shipping_cost: string | null;
  currency: string;
  stock_status: string;
  available_quantity: number | null;
  delivery_min_days: number | null;
  delivery_max_days: number | null;
  delivery_speed: string;
  seller_name: string | null;
  sold_by_marketplace: boolean;
  url: string | null;
}

export interface TargetListingSummary {
  id: number;
  provider: string;
  title: string;
  price: string | null;
  shipping_price: string | null;
  minimum_sale_price: string | null;
  currency: string;
  url: string | null;
}

export interface Opportunity {
  id: number;
  reference: string;
  state: OpportunityState;
  currency: string;
  quantity: number;
  product_id: number | null;
  product: ProductSummary | null;
  links: MarketplaceLinks | null;
  source_price: string | null;
  target_price: string | null;
  total_costs: string | null;
  expected_net_profit: string | null;
  worst_case_net_profit: string | null;
  best_case_net_profit: string | null;
  profit_margin: string | null;
  roi: string | null;
  capital_required: string | null;
  risk_score: number | null;
  risk_level: RiskLevel | null;
  match_confidence: string | null;
  decision: string | null;
  decision_reasons: string[];
  blocked_reason: string | null;
  rejected_reason: string | null;
  source_price_timestamp: string | null;
  inventory_timestamp: string | null;
  last_revalidated_at: string | null;
  created_at: string;
}

export interface ProfitCalculation {
  scenario: "BEST_CASE" | "BASE_CASE" | "WORST_CASE";
  currency: string;
  sale_revenue: string;
  source_purchase_cost: string;
  source_shipping_cost: string;
  marketplace_fees: string;
  payment_fees: string;
  fulfillment_cost: string;
  outbound_shipping_cost: string;
  packaging_cost: string;
  expected_return_cost: string;
  risk_reserve: string;
  other_variable_costs: string;
  net_vat: string;
  total_costs: string;
  net_profit: string;
  profit_margin: string | null;
  roi: string | null;
  capital_required: string;
  assumptions: string[];
  fee_breakdown: Array<Record<string, unknown>>;
  profit_model_version: string;
  calculated_at: string;
}

export interface RiskFactor {
  factor: string;
  score: number;
  weight: string;
  reason: string;
  blocking: boolean;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
  blockers: string[];
  reasons: string[];
  is_blocking: boolean;
  risk_model_version: string;
  assessed_at: string;
}

export interface OpportunityDetail extends Opportunity {
  source_offer: SourceOfferSummary | null;
  target_listing: TargetListingSummary | null;
  profit_calculations: ProfitCalculation[];
  risk_assessments: RiskAssessment[];
  staleness: string[];
}

export interface Order {
  id: number;
  reference: string;
  state: OrderState;
  provider: string;
  external_order_id: string;
  currency: string;
  quantity: number;
  sale_price: string;
  buyer_shipping_paid: string;
  expected_net_profit: string | null;
  worst_case_net_profit: string | null;
  expected_margin: string | null;
  expected_roi: string | null;
  capital_required: string | null;
  risk_score: number | null;
  match_confidence: string | null;
  realized_net_profit: string | null;
  profit_variance: string | null;
  approved_at: string | null;
  blocked_reason: string | null;
  created_at: string;
}

export interface ApprovalSummary {
  order_reference: string;
  state: OrderState;
  execution_mode: string;
  currency: string;
  quantity: number;
  sale: { sale_price: string; buyer_shipping_paid: string; sold_at: string | null; delivery_deadline: string | null };
  source: {
    price: string | null;
    shipping: string | null;
    availability: string;
    available_quantity: number | null;
    delivery_estimate_days: [number | null, number | null] | null;
    seller: string | null;
  };
  costs: Record<string, string>;
  expected_net_profit: string | null;
  worst_case_net_profit: string | null;
  profit_margin: string | null;
  roi: string | null;
  capital_required: string | null;
  risk_score: number | null;
  match_confidence: string | null;
  compliance: string | null;
  revalidation: { ok?: boolean; problems?: string[]; checks?: Record<string, string> };
  can_approve: boolean;
}

export interface OrderEvent {
  event_type: string;
  from_state: OrderState | null;
  to_state: OrderState | null;
  actor: string;
  message: string | null;
  occurred_at: string;
}

export interface OrderDetail extends Order {
  events: OrderEvent[];
  approval_summary: ApprovalSummary;
}

export interface Listing {
  id: number;
  provider: string;
  external_id: string | null;
  sku: string | null;
  title: string;
  state: string;
  condition: string;
  currency: string;
  price: string | null;
  minimum_sale_price: string | null;
  recommended_sale_price: string | null;
  quantity: number;
  is_own_listing: boolean;
  url: string | null;
  published_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface Shipment {
  id: number;
  order_id: number;
  direction: string;
  state: ShipmentState;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipping_cost: string;
  currency: string;
  estimated_delivery: string | null;
  actual_delivery: string | null;
  created_at: string;
}

export interface ReturnRecord {
  id: number;
  order_id: number;
  state: string;
  reason: string | null;
  refund_amount: string;
  return_shipping_cost: string;
  total_return_cost: string;
  currency: string;
  requested_at: string | null;
  closed_at: string | null;
}

export interface DashboardSummary {
  opportunities_today: number;
  opportunities_above_threshold: number;
  average_expected_profit: string;
  total_expected_profit: string;
  actionable_count: number;
  listed_count: number;
  orders_open: number;
  pending_approvals: number;
  capital_exposed: string;
  realized_profit_total: string;
  profit_variance_total: string;
  risk_distribution: Record<string, number>;
  failed_opportunities: number;
  blocked_opportunities: number;
  returns_open: number;
  currency: string;
}

export interface Analytics {
  dashboard: DashboardSummary;
  expected_vs_realized: Array<{
    order_reference: string;
    completed_at: string | null;
    expected_net_profit: string;
    realized_net_profit: string;
    variance: string;
    sale_price: string;
    state: string;
  }>;
  rejection_breakdown: Record<string, number>;
}

export interface Backtest {
  available: boolean;
  reason: string;
  window_start: string | null;
  window_end: string | null;
  observations: number;
  products_covered: number;
  opportunities_evaluated: number;
  passed_filters: number;
  reached_profit_threshold: number;
  source_price_changes: number;
  stock_disappearances: number;
  total_expected_profit: string;
  notes: string[];
}

export interface SettingsPayload {
  values: Record<string, unknown>;
  groups: Record<string, string[]>;
  runtime: Record<string, unknown>;
}

export interface AuditEntry {
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor: string;
  old_state: string | null;
  new_state: string | null;
  request_id: string | null;
  meta: Record<string, unknown>;
  occurred_at: string;
}

export interface Health {
  status: string;
  environment: string;
  demo_mode: boolean;
  research_mode?: boolean;
  auth_required?: boolean;
  simulation_mode: boolean;
  automation_level: number;
  providers: Record<string, string | boolean>;
  model_versions: Record<string, string>;
}

export interface ApiError {
  error: { code: string; message: string; context: Record<string, unknown>; retryable: boolean };
}

export interface ResearchSummary {
  analysed: number;
  actionable: number;
  rejected: number;
  blocked: number;
  errors: string[];
}

/** A checked product, with the arithmetic that produced the verdict. */
export interface ResearchOpportunity extends Opportunity {
  profit: ProfitCalculation | null;
}

export interface ResearchResponse {
  summary: ResearchSummary;
  opportunities: ResearchOpportunity[];
  errors: string[];
}
