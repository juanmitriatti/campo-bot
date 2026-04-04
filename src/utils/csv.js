export function generateCSV(rows) {
  const headers = ["Fecha", "Categoría", "Descripción", "Monto", "Moneda", "Campo/Lote"];
  const lines = [headers.join(",")];

  for (const row of rows) {
    const fecha = new Date(row.expense_date).toLocaleDateString("es-AR", { timeZone: 'America/Argentina/Buenos_Aires' });
    const desc = `"${(row.description || "").replace(/"/g, '""')}"`;
    const monto = Number(row.amount);
    const campo = row.field_name || "";
    lines.push([fecha, row.category, desc, monto, row.currency, campo].join(","));
  }

  return lines.join("\n");
}
