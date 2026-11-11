import type { ImpactSeverity } from '../constants/impactSeverity';

export type { ImpactSeverity };

export interface ImpactNode {
  asset_id: string;
  asset_name: string;
  asset_type: string;
  column: string;
  depth: number;
  edge_kind: string;
  severity: string;
}

export interface CoverageGap {
  gap_id: string;
  kind: string;
  in_scope: boolean;
  transformation_id: string;
  transformation_name: string;
  parse_status: string;
  asset_id: string | null;
  asset_name: string | null;
  column: string | null;
  missing_columns: string[];
  detail: string;
  uncertain_assets: string[];
}

export interface ImpactCoverage {
  checklist_complete: boolean;
  in_scope_gap_count: number;
  total_gap_count: number;
  in_scope: CoverageGap[];
  other_gaps: CoverageGap[];
  gap_reasons: string[];
  uncertain_scope: string[];
  disclaimer: string;
}

export interface ImpactReport {
  target: { asset_id: string; asset_name: string; column: string | null; change_type: string };
  state_hash?: string;
  summary: {
    severity: string;
    severity_label: string;
    affected_assets: number;
    affected_columns: number;
    reports: number;
    min_depth: number | null;
    max_depth: number;
    truncated: boolean;
    depth_limit: number;
    checklist_complete?: boolean;
    in_scope_gap_count?: number;
  };
  nodes: ImpactNode[];
  paths: { target: { asset_id: string; asset_name: string; column: string }; depth: number; path: any[] }[];
  cycles: { nodes: any[]; sample_path: any[] }[];
  cycle_hit: boolean;
  migration_checklist: {
    asset_id: string;
    asset_name: string;
    column: string;
    action: string;
    suggested_sql: string;
    reason: string;
    severity: string;
    depth: number;
  }[];
  coverage?: ImpactCoverage;
  truncated: boolean;
  excluded_from_checklist: string[];
}

export interface ImpactAnalysis {
  id: string;
  requested_by: string;
  change_type: string;
  target_asset_id: string;
  target_column: string | null;
  severity: ImpactSeverity;
  affected_count: number;
  state_hash?: string | null;
  report_json: ImpactReport;
  created_at: string;
  cached: boolean;
  target_asset_name: string | null;
}
