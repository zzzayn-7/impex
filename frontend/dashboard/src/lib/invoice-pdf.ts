// Print and Download of an invoice PDF, from the browser. Both fetch the file with the administrator's own session (the dashboard route checks it); neither ever puts the
// dashboard itself on paper. Every call answers with what happened so the caller can say it in words.

export type PdfOutcome = "ok" | "unauthorized" | "failed" | "unreachable";

/** PRINT: the PDF is handed to the browser's print dialog from a hidden frame, so the sidebar, header and buttons are never part of what is printed. If the browser will not print from
 *  a frame, the PDF opens in a tab instead. `url` is the PDF route without the inline flag. */
export async function printPdf(url: string): Promise<PdfOutcome> {
  try {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}inline=1`, { cache: "no-store" });
    if (res.status === 401) return "unauthorized";
    if (!res.ok) return "failed";
    const blobUrl = URL.createObjectURL(await res.blob());
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.title = "Invoice to print";
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    const cleanup = () => { URL.revokeObjectURL(blobUrl); frame.remove(); };
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        window.open(blobUrl, "_blank");
      }
      setTimeout(cleanup, 120000);
    };
    frame.src = blobUrl;
    document.body.appendChild(frame);
    return "ok";
  } catch {
    return "unreachable";
  }
}

/** DOWNLOAD: the PDF is saved under `filename` (a safe name made by the caller). */
export async function downloadPdf(url: string, filename: string): Promise<PdfOutcome> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 401) return "unauthorized";
    if (!res.ok) return "failed";
    const blobUrl = URL.createObjectURL(await res.blob());
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    return "ok";
  } catch {
    return "unreachable";
  }
}

/** A filename that is safe on every system: letters, digits, dots, dashes and underscores only. */
export const pdfName = (number: string | null | undefined) => `${(number ?? "invoice").replace(/[^A-Za-z0-9._-]/g, "") || "invoice"}.pdf`;

export const pdfProblem = (outcome: PdfOutcome): string | null =>
  outcome === "failed" ? "The invoice could not be prepared. Please try again." : outcome === "unreachable" ? "Unable to reach the server. Please try again." : null;
