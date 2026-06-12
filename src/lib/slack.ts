import { envvars } from "@trigger.dev/sdk/v3";

export interface AutomationReport {
  totalChecked: number;
  highConfidence: number;
  totalStatusUpdates: number;
  statusBreakdown: Map<string, number>;
  newPendings: number;
  spreadsheetUrl?: string | null;
  spreadsheetError?: string | null;
}

export async function postAutomationReport(report: AutomationReport): Promise<void> {
  const webhookUrl = (
    await envvars.retrieve("SLACK_AUTOMATION_REPORTS_WEBHOOK_URL")
  ).value;

  const highPct =
    report.totalChecked > 0
      ? Math.round((report.highConfidence / report.totalChecked) * 100)
      : 0;

  const lines: string[] = [
    `*Zillow non-HSLP order weekly report*`,
    `• Total records checked: *${report.totalChecked}*`,
    `• High confidence: *${report.highConfidence} / ${highPct}%*`,
    `• New status updates: *${report.totalStatusUpdates}*`,
  ];

  if (report.statusBreakdown.size > 0) {
    const sorted = [...report.statusBreakdown.entries()].sort(
      (a, b) => b[1] - a[1]
    );
    for (const [status, count] of sorted) {
      lines.push(`    – ${status}: ${count}`);
    }
  }

  lines.push(
    `• New pendings (SST Pending Email Offer scheduled): *${report.newPendings}*`
  );

  if (report.spreadsheetUrl) {
    lines.push(`• Spreadsheet: ${report.spreadsheetUrl}`);
  } else if (report.spreadsheetError) {
    lines.push(`• :warning: Spreadsheet write FAILED: ${report.spreadsheetError}`);
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: lines.join("\n") }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${errorText}`);
  }
}
