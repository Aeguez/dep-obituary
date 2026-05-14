import { NextRequest, NextResponse } from "next/server";
import type { ScanResponse } from "../route";
import type { ScoreResult } from "@/lib/scorer";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

interface ScanRow {
  scan_id: string;
  total_packages: number;
  critical_count: number | null;
  high_count: number | null;
  results: ScoreResult[];
  created_at: string | null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ scanId: string }> }
) {
  const { scanId } = await params;
  const supabase = getSupabaseAdmin();

  if (!supabase) {
    return NextResponse.json(
      { error: "Saved scans are unavailable because Supabase is not configured." },
      { status: 503 }
    );
  }

  try {
    const { data, error } = await supabase
      .from("scans")
      .select("scan_id,total_packages,critical_count,high_count,results,created_at")
      .eq("scan_id", scanId)
      .maybeSingle<ScanRow>();

    if (error) {
      console.warn(`Saved scan lookup failed for ${scanId}:`, error.message);
      return NextResponse.json(
        { error: "Saved scan is temporarily unavailable." },
        { status: 503 }
      );
    }

    if (!data) {
      return NextResponse.json({ error: "Scan not found" }, { status: 404 });
    }

    const response: ScanResponse = {
      results: data.results,
      totalPackages: data.total_packages,
      criticalCount: data.critical_count || 0,
      highCount: data.high_count || 0,
      scanId: data.scan_id,
      scannedAt: data.created_at || new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.warn(`Saved scan lookup failed for ${scanId}:`, error);
    return NextResponse.json(
      { error: "Saved scan is temporarily unavailable." },
      { status: 503 }
    );
  }
}
