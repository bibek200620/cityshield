export function downloadCsv(filename: string, rows: readonly (readonly (string | number | null)[])[]) {
  const csv = rows.map((row) => row.map((value) => {
    if (typeof value === "number") return String(value);
    const field = value ?? "";
    return `"${field.replace(/"/g, '""')}"`;
  }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv + "\r\n"], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
