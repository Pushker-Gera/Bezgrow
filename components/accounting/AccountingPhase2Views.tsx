"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api/client-fetch";
import { pickPurchaseAttachment } from "@/lib/purchase-attachments";

type Row = Record<string, unknown>;
type Report = Row & { rows?: Row[] };
type Submit = (path: string, body: Row) => Promise<void>;

const fieldClass =
  "min-h-10 rounded-xl border border-white/10 bg-black px-3 py-2 text-sm text-white placeholder:text-neutral-600";
const buttonClass =
  "min-h-10 rounded-xl bg-cyan-300 px-4 text-sm font-black text-black disabled:opacity-40";
const panelClass =
  "space-y-4 rounded-lg border border-white/10 bg-white/[0.025] p-4";
const preferredColumns = [
  "purchase_date",
  "invoice_date",
  "payment_date",
  "note_date",
  "transaction_date",
  "locked_through",
  "supplier_invoice_number",
  "invoice_number",
  "voucher",
  "voucher_number",
  "party_name",
  "supplier_name",
  "customer",
  "display_name",
  "description",
  "state",
  "transaction_type",
  "status",
  "reconciliation_status",
  "quantity",
  "taxable_minor",
  "cgst_minor",
  "sgst_minor",
  "igst_minor",
  "grand_total_minor",
  "amount_minor",
  "outstanding_minor",
  "overdue_minor",
  "current_balance_minor",
  "warning",
];
const today = () => new Date().toISOString().slice(0, 10);
const asText = (value: unknown, fallback = "—") =>
  value === null || value === undefined || value === ""
    ? fallback
    : String(value);
const asNumber = (value: unknown) =>
  Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (value: unknown) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    asNumber(value) / 100,
  );

async function readPayload(response: Response) {
  const result = (await response.json()) as Row;
  if (!response.ok || result.success === false)
    throw new Error(
      asText(result.error, "Accounting reference data could not be loaded."),
    );
  return result;
}

function named(row: Row) {
  return asText(
    row.name ??
      row.display_name ??
      row.product_name ??
      row.customer_name ??
      row.supplier_name,
  );
}

function SmartTable({
  rows,
  empty = "No records in this period.",
}: {
  rows: Row[];
  empty?: string;
}) {
  const columns = useMemo(() => {
    const keys = new Set(rows.flatMap((row) => Object.keys(row)));
    return [
      ...preferredColumns.filter((key) => keys.has(key)),
      ...[...keys].filter(
        (key) =>
          !preferredColumns.includes(key) &&
          !key.endsWith("_id") &&
          ![
            "id",
            "organization_id",
            "financial_year_id",
            "deleted_at",
            "sync_status",
          ].includes(key),
      ),
    ].slice(0, 12);
  }, [rows]);
  if (!rows.length)
    return (
      <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-sm text-neutral-500">
        {empty}
      </div>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-white/[0.05] text-[10px] uppercase tracking-wider text-neutral-500">
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                className="whitespace-nowrap px-3 py-3 font-black"
              >
                {column.replaceAll("_", " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {rows.map((row, index) => (
            <tr key={asText(row.id, String(index))} className="bg-black/20">
              {columns.map((column) => (
                <td
                  key={column}
                  className="max-w-80 whitespace-nowrap px-3 py-3"
                >
                  {column.endsWith("_minor") ? (
                    <span className="font-mono font-bold">
                      {money(row[column])}
                    </span>
                  ) : (
                    asText(row[column])
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportActions({ view, rows }: { view: string; rows: Row[] }) {
  function exportRows() {
    if (!rows.length) return;
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const quote = (value: unknown) =>
      `"${(value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll('"', '""')}"`;
    const csv = [
      columns.map(quote).join(","),
      ...rows.map((row) =>
        columns.map((column) => quote(row[column])).join(","),
      ),
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `bezgrow-${view}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="flex justify-end gap-2 print:hidden">
      <button
        type="button"
        onClick={exportRows}
        disabled={!rows.length}
        className="min-h-10 rounded-xl border border-white/10 px-4 text-xs font-black disabled:opacity-35"
      >
        Export CSV
      </button>
      <button
        type="button"
        onClick={() => window.print()}
        className="min-h-10 rounded-xl border border-white/10 px-4 text-xs font-black"
      >
        Print
      </button>
    </div>
  );
}

type Reference = {
  suppliers: Row[];
  customers: Row[];
  products: Row[];
  warehouses: Row[];
  accounts: Row[];
  bankAccounts: Row[];
  purchases: Row[];
  purchaseItems: Row[];
  salesInvoices: Row[];
  salesItems: Row[];
  advances: Row[];
  locks: Row[];
};

const emptyReference: Reference = {
  suppliers: [],
  customers: [],
  products: [],
  warehouses: [],
  accounts: [],
  bankAccounts: [],
  purchases: [],
  purchaseItems: [],
  salesInvoices: [],
  salesItems: [],
  advances: [],
  locks: [],
};

export function AccountingPhase2Views({
  view,
  report,
  organizationId,
  financialYearId,
  saving,
  onSubmit,
}: {
  view: string;
  report: Report;
  organizationId: string;
  financialYearId: string;
  saving: boolean;
  onSubmit: Submit;
}) {
  const [reference, setReference] = useState<Reference>(emptyReference);
  const [referenceError, setReferenceError] = useState("");

  async function loadReference() {
    if (!organizationId || !financialYearId) return;
    try {
      const query = new URLSearchParams({
        organization_id: organizationId,
        financial_year_id: financialYearId,
      });
      const result = await readPayload(
        await apiFetch(`/api/accounting/reference-data?${query}`, {
          cache: "no-store",
        }),
      );
      setReference({ ...emptyReference, ...(result as unknown as Reference) });
      setReferenceError("");
    } catch (error) {
      setReferenceError(
        error instanceof Error
          ? error.message
          : "Reference data could not be loaded.",
      );
    }
  }

  useEffect(() => {
    if (!organizationId || !financialYearId) return;
    let active = true;
    const query = new URLSearchParams({
      organization_id: organizationId,
      financial_year_id: financialYearId,
    });
    void apiFetch(`/api/accounting/reference-data?${query}`, {
      cache: "no-store",
    })
      .then(readPayload)
      .then((result) => {
        if (!active) return;
        setReference({
          ...emptyReference,
          ...(result as unknown as Reference),
        });
        setReferenceError("");
      })
      .catch((error: unknown) => {
        if (active)
          setReferenceError(
            error instanceof Error
              ? error.message
              : "Reference data could not be loaded.",
          );
      });
    return () => {
      active = false;
    };
  }, [organizationId, financialYearId]);
  async function submit(path: string, body: Row) {
    await onSubmit(path, body);
    await loadReference();
  }
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const contents = (() => {
    if (view === "purchases" || view === "purchase-returns")
      return (
        <div className="space-y-4">
          <PurchaseEditor
            isReturn={view === "purchase-returns"}
            reference={reference}
            rows={rows}
            saving={saving}
            onSubmit={submit}
          />
          {view === "purchases" ? (
            <PurchaseAttachmentEditor
              organizationId={organizationId}
              purchases={rows}
              saving={saving}
              onSubmit={submit}
            />
          ) : null}
        </div>
      );
    if (view === "supplier-payments" || view === "customer-receipts")
      return (
        <SettlementEditor
          partyType={view === "supplier-payments" ? "supplier" : "customer"}
          reference={reference}
          rows={rows}
          saving={saving}
          onSubmit={submit}
        />
      );
    if (view === "suppliers")
      return <SupplierEditor rows={rows} saving={saving} onSubmit={submit} />;
    if (view === "bank-accounts")
      return (
        <BankAccountEditor rows={rows} saving={saving} onSubmit={submit} />
      );
    if (view === "bank-reconciliation")
      return (
        <ReconciliationEditor
          rows={rows}
          reference={reference}
          saving={saving}
          onSubmit={submit}
        />
      );
    if (view === "credit-notes")
      return (
        <CreditNoteEditor
          rows={rows}
          reference={reference}
          saving={saving}
          onSubmit={submit}
        />
      );
    if (view === "period-locking")
      return <PeriodLockEditor rows={rows} saving={saving} onSubmit={submit} />;
    if (view === "gst-overview" || view === "gstr-3b")
      return <GstOverview report={report} />;
    if (view === "gstr-1") return <GstrOne report={report} />;
    return (
      <section className="space-y-4">
        <ExportActions view={view} rows={rows} />
        <SmartTable rows={rows} />
      </section>
    );
  })();
  return (
    <div className="space-y-4">
      {referenceError ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-sm text-amber-100"
        >
          {referenceError}
        </div>
      ) : null}
      {contents}
    </div>
  );
}

type PurchaseLine = {
  key: string;
  product_id: string;
  product_name: string;
  description: string;
  quantity: string;
  unit_cost: string;
  discount_percent: string;
  gst_rate: string;
  cess: string;
  hsn_code: string;
  unit: string;
  purchase_classification: string;
  purchase_account_id: string;
  warehouse_id: string;
  batch_no: string;
  expiry_date: string;
};
const newPurchaseLine = (): PurchaseLine => ({
  key: crypto.randomUUID(),
  product_id: "",
  product_name: "",
  description: "",
  quantity: "1",
  unit_cost: "",
  discount_percent: "0",
  gst_rate: "18",
  cess: "0",
  hsn_code: "",
  unit: "pcs",
  purchase_classification: "INVENTORY",
  purchase_account_id: "",
  warehouse_id: "",
  batch_no: "",
  expiry_date: "",
});

function PurchaseAttachmentEditor({
  organizationId,
  purchases,
  saving,
  onSubmit,
}: {
  organizationId: string;
  purchases: Row[];
  saving: boolean;
  onSubmit: Submit;
}) {
  const [purchaseId, setPurchaseId] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [notice, setNotice] = useState("");
  async function choose() {
    if (!purchaseId) return;
    setChoosing(true);
    setNotice("");
    try {
      const attachment = await pickPurchaseAttachment(
        organizationId,
        purchaseId,
      );
      if (!attachment) return;
      await onSubmit("/api/purchases/attachments/save", {
        purchase_id: purchaseId,
        relative_path: attachment.relativePath,
        file_name: attachment.fileName,
        media_type: attachment.mediaType,
        size_bytes: attachment.bytes,
        sha256: attachment.sha256,
      });
      setNotice(
        `${attachment.fileName} is stored locally and included in native backups.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The attachment could not be saved.",
      );
    } finally {
      setChoosing(false);
    }
  }
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/[0.025] p-4">
      <div className="min-w-60 flex-1">
        <p className="text-xs font-black uppercase tracking-wider text-neutral-400">
          Optional supplier invoice attachment
        </p>
        <p className="mt-1 text-xs text-neutral-600">
          PDF or image, up to 20 MB; retained locally with backup and restore.
        </p>
      </div>
      <select
        aria-label="Purchase for attachment"
        value={purchaseId}
        onChange={(event) => setPurchaseId(event.target.value)}
        className={`${fieldClass} min-w-64`}
      >
        <option value="">Select posted purchase</option>
        {purchases
          .filter((row) => row.document_status === "POSTED")
          .map((row) => (
            <option key={asText(row.id)} value={asText(row.id, "")}>
              {asText(row.supplier_invoice_number)} ·{" "}
              {asText(row.supplier_name)}
            </option>
          ))}
      </select>
      <button
        type="button"
        disabled={saving || choosing || !purchaseId}
        onClick={() => void choose()}
        className={buttonClass}
      >
        {choosing ? "Choosing…" : "Add PDF / photo"}
      </button>
      {notice ? (
        <p role="status" className="w-full text-xs text-amber-100">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

function PurchaseEditor({
  isReturn,
  reference,
  rows,
  saving,
  onSubmit,
}: {
  isReturn: boolean;
  reference: Reference;
  rows: Row[];
  saving: boolean;
  onSubmit: Submit;
}) {
  const [lines, setLines] = useState<PurchaseLine[]>(() => [newPurchaseLine()]);
  const [originalId, setOriginalId] = useState("");
  const original = reference.purchases.find(
    (purchase) => purchase.id === originalId,
  );
  const sourceItems = reference.purchaseItems.filter(
    (item) => item.purchase_invoice_id === originalId,
  );
  function update(key: string, patch: Partial<PurchaseLine>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }
  function selectProduct(key: string, productId: string) {
    const product = reference.products.find((row) => row.id === productId);
    update(key, {
      product_id: productId,
      product_name: named(product || {}),
      hsn_code: asText(product?.hsn_code, ""),
      unit: asText(product?.unit, "pcs"),
      unit_cost: asText(product?.purchase_rate, ""),
      warehouse_id: asText(product?.warehouse_id, ""),
    });
  }
  function selectReturnItem(key: string, itemId: string) {
    const item = sourceItems.find((row) => row.id === itemId);
    if (!item) return;
    update(key, {
      product_id: asText(item.product_id, ""),
      product_name: asText(item.product_name, ""),
      hsn_code: asText(item.hsn_code, ""),
      unit: asText(item.unit, "pcs"),
      unit_cost: String(asNumber(item.unit_cost_minor) / 100),
      gst_rate: String(asNumber(item.gst_rate_basis_points) / 100),
      quantity: "1",
      purchase_classification: asText(
        item.purchase_classification,
        "INVENTORY",
      ),
      purchase_account_id: asText(item.purchase_account_id, ""),
    });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries()) as Row;
    await onSubmit(
      isReturn ? "/api/purchases/return" : "/api/purchases/create",
      {
        ...body,
        return_against_id: isReturn ? originalId : undefined,
        supplier_id: isReturn ? original?.supplier_id : body.supplier_id,
        itc_status: isReturn ? original?.itc_status : body.itc_status,
        idempotency_key: crypto.randomUUID(),
        items: lines.map(({ key, ...line }) => {
          void key;
          return line;
        }),
      },
    );
    form.reset();
    setLines([newPurchaseLine()]);
    setOriginalId("");
  }
  return (
    <section className="space-y-4">
      <form onSubmit={save} className={panelClass}>
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-cyan-300">
            {isReturn
              ? "Purchase return / debit note"
              : "Supplier purchase invoice"}
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            Tax, stock, payable, and the authoritative journal post atomically.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {isReturn ? (
            <select
              aria-label="Original purchase"
              required
              value={originalId}
              onChange={(event) => {
                setOriginalId(event.target.value);
                setLines([newPurchaseLine()]);
              }}
              className={fieldClass}
            >
              <option value="">Original purchase</option>
              {reference.purchases.map((row) => (
                <option key={asText(row.id)} value={asText(row.id, "")}>
                  {asText(row.supplier_invoice_number ?? row.bill_number)} ·{" "}
                  {asText(
                    reference.suppliers.find(
                      (supplier) => supplier.id === row.supplier_id,
                    )?.name,
                  )}
                </option>
              ))}
            </select>
          ) : (
            <select name="supplier_id" required className={fieldClass}>
              <option value="">Supplier</option>
              {reference.suppliers.map((row) => (
                <option key={asText(row.id)} value={asText(row.id, "")}>
                  {named(row)}
                </option>
              ))}
            </select>
          )}
          <input
            name="supplier_invoice_number"
            required
            placeholder={
              isReturn ? "Debit note number" : "Supplier invoice number"
            }
            className={fieldClass}
          />
          <input
            type="date"
            name="purchase_date"
            required
            defaultValue={today()}
            className={fieldClass}
          />
          <input type="date" name="due_date" className={fieldClass} />
          <select name="supply_type" className={fieldClass}>
            <option value="INTRA_STATE">Intrastate</option>
            <option value="INTER_STATE">Interstate</option>
          </select>
          <select name="tax_category" className={fieldClass}>
            <option value="TAXABLE">Taxable</option>
            <option value="EXEMPT">Exempt</option>
            <option value="NIL_RATED">Nil-rated</option>
            <option value="NON_GST">Non-GST</option>
          </select>
          <input
            name="place_of_supply"
            placeholder="Place of supply / state"
            className={fieldClass}
          />
          <select
            name="itc_status"
            defaultValue="REVIEW_REQUIRED"
            className={fieldClass}
          >
            <option value="REVIEW_REQUIRED">ITC review required</option>
            <option value="ELIGIBLE">ITC eligible</option>
            <option value="INELIGIBLE">ITC ineligible</option>
          </select>
          <input
            name="other_charges"
            inputMode="decimal"
            placeholder="Other charges"
            className={fieldClass}
          />
          <input
            name="round_off"
            inputMode="decimal"
            placeholder="Round off (+/-)"
            className={fieldClass}
          />
          <label className={`${fieldClass} flex items-center gap-2`}>
            <input type="checkbox" name="reverse_charge" value="true" /> Reverse
            charge
          </label>
          <input name="notes" placeholder="Notes" className={fieldClass} />
        </div>
        <div className="space-y-3">
          {lines.map((line, index) => (
            <article
              key={line.key}
              className="grid gap-2 rounded-xl border border-white/10 p-3 md:grid-cols-4 xl:grid-cols-8"
            >
              <span className="text-xs font-black text-neutral-500">
                Line {index + 1}
              </span>
              {isReturn ? (
                <select
                  aria-label={`Original line ${index + 1}`}
                  required
                  onChange={(event) =>
                    selectReturnItem(line.key, event.target.value)
                  }
                  className={fieldClass}
                >
                  <option value="">Original item</option>
                  {sourceItems.map((item) => (
                    <option key={asText(item.id)} value={asText(item.id, "")}>
                      {asText(item.product_name)} · available{" "}
                      {asText(
                        item.available_batch_quantity,
                        item.quantity as string,
                      )}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  aria-label={`Product ${index + 1}`}
                  value={line.product_id}
                  onChange={(event) =>
                    selectProduct(line.key, event.target.value)
                  }
                  className={fieldClass}
                >
                  <option value="">Product / service</option>
                  {reference.products.map((product) => (
                    <option
                      key={asText(product.id)}
                      value={asText(product.id, "")}
                    >
                      {named(product)}
                    </option>
                  ))}
                </select>
              )}
              <input
                aria-label={`Description ${index + 1}`}
                value={line.description}
                onChange={(event) =>
                  update(line.key, { description: event.target.value })
                }
                placeholder="Description"
                className={fieldClass}
              />
              <input
                aria-label={`Quantity ${index + 1}`}
                required
                inputMode="decimal"
                value={line.quantity}
                onChange={(event) =>
                  update(line.key, { quantity: event.target.value })
                }
                placeholder="Qty"
                className={fieldClass}
              />
              <input
                aria-label={`Rate ${index + 1}`}
                required
                inputMode="decimal"
                value={line.unit_cost}
                onChange={(event) =>
                  update(line.key, { unit_cost: event.target.value })
                }
                placeholder="Rate"
                className={fieldClass}
              />
              <input
                aria-label={`Discount ${index + 1}`}
                inputMode="decimal"
                value={line.discount_percent}
                onChange={(event) =>
                  update(line.key, { discount_percent: event.target.value })
                }
                placeholder="Discount %"
                className={fieldClass}
              />
              <input
                aria-label={`GST rate ${index + 1}`}
                inputMode="decimal"
                value={line.gst_rate}
                onChange={(event) =>
                  update(line.key, { gst_rate: event.target.value })
                }
                placeholder="GST %"
                className={fieldClass}
              />
              <select
                aria-label={`Classification ${index + 1}`}
                value={line.purchase_classification}
                onChange={(event) =>
                  update(line.key, {
                    purchase_classification: event.target.value,
                  })
                }
                className={fieldClass}
              >
                <option value="INVENTORY">Inventory</option>
                <option value="EXPENSE">Expense</option>
                <option value="FIXED_ASSET">Fixed asset</option>
                <option value="OTHER">Other</option>
              </select>
              <input
                aria-label={`HSN ${index + 1}`}
                value={line.hsn_code}
                onChange={(event) =>
                  update(line.key, { hsn_code: event.target.value })
                }
                placeholder="HSN/SAC"
                className={fieldClass}
              />
              <select
                aria-label={`Warehouse ${index + 1}`}
                value={line.warehouse_id}
                onChange={(event) =>
                  update(line.key, { warehouse_id: event.target.value })
                }
                className={fieldClass}
              >
                <option value="">Warehouse</option>
                {reference.warehouses.map((warehouse) => (
                  <option
                    key={asText(warehouse.id)}
                    value={asText(warehouse.id, "")}
                  >
                    {named(warehouse)}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Batch ${index + 1}`}
                value={line.batch_no}
                onChange={(event) =>
                  update(line.key, { batch_no: event.target.value })
                }
                placeholder="Batch / lot"
                className={fieldClass}
              />
              <input
                aria-label={`Expiry ${index + 1}`}
                type="date"
                value={line.expiry_date}
                onChange={(event) =>
                  update(line.key, { expiry_date: event.target.value })
                }
                className={fieldClass}
              />
              <button
                type="button"
                disabled={lines.length === 1}
                onClick={() =>
                  setLines((current) =>
                    current.filter((item) => item.key !== line.key),
                  )
                }
                className="min-h-10 rounded-xl border border-rose-300/20 text-xs font-black text-rose-200 disabled:opacity-30"
              >
                Remove
              </button>
            </article>
          ))}
        </div>
        <div className="flex flex-wrap justify-between gap-3">
          <button
            type="button"
            onClick={() =>
              setLines((current) => [...current, newPurchaseLine()])
            }
            className="min-h-10 rounded-xl border border-white/10 px-4 text-xs font-black"
          >
            Add line
          </button>
          <button disabled={saving} className={buttonClass}>
            {saving
              ? "Posting…"
              : isReturn
                ? "Post debit note"
                : "Post purchase"}
          </button>
        </div>
      </form>
      {!isReturn ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            await onSubmit(
              "/api/purchases/reverse",
              Object.fromEntries(new FormData(form).entries()),
            );
            form.reset();
          }}
          className="flex flex-wrap gap-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3"
        >
          <select
            name="purchase_id"
            required
            className={`${fieldClass} flex-1`}
          >
            <option value="">Posted purchase to reverse</option>
            {rows
              .filter((row) => row.document_status === "POSTED")
              .map((row) => (
                <option key={asText(row.id)} value={asText(row.id, "")}>
                  {asText(row.supplier_invoice_number)} ·{" "}
                  {asText(row.supplier_name)}
                </option>
              ))}
          </select>
          <input
            name="reason"
            required
            placeholder="Required reason"
            className={`${fieldClass} flex-[2]`}
          />
          <input
            type="date"
            name="reversal_date"
            required
            defaultValue={today()}
            className={fieldClass}
          />
          <button
            disabled={saving}
            className="min-h-10 rounded-xl border border-amber-300/30 px-4 text-sm font-black text-amber-100"
          >
            Reverse safely
          </button>
        </form>
      ) : null}
      <ExportActions
        view={isReturn ? "purchase-returns" : "purchases"}
        rows={rows}
      />
      <SmartTable rows={rows} />
    </section>
  );
}

function SettlementEditor({
  partyType,
  reference,
  rows,
  saving,
  onSubmit,
}: {
  partyType: "supplier" | "customer";
  reference: Reference;
  rows: Row[];
  saving: boolean;
  onSubmit: Submit;
}) {
  const parties =
    partyType === "supplier" ? reference.suppliers : reference.customers;
  const documents =
    partyType === "supplier" ? reference.purchases : reference.salesInvoices;
  const [partyId, setPartyId] = useState("");
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const matching = documents.filter(
    (row) =>
      row[`${partyType}_id`] === partyId && asNumber(row.outstanding_minor) > 0,
  );
  const accounts = reference.accounts.filter(
    (row) =>
      row.system_role === "CASH" ||
      row.system_role === "BANK" ||
      asNumber(row.is_cash_account) ||
      asNumber(row.is_bank_account),
  );
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    await onSubmit(
      partyType === "supplier"
        ? "/api/purchases/supplier-payment"
        : "/api/payments/create",
      {
        ...Object.fromEntries(new FormData(form).entries()),
        party_type: partyType,
        party_id: partyId,
        idempotency_key: crypto.randomUUID(),
        allocations: matching.flatMap((row) =>
          asNumber(allocations[asText(row.id, "")]) > 0
            ? [
                {
                  document_id: row.id,
                  allocation_amount: allocations[asText(row.id, "")],
                },
              ]
            : [],
        ),
      },
    );
    form.reset();
    setPartyId("");
    setAllocations({});
  }
  const advances = reference.advances.filter(
    (advance) => advance.party_type === partyType,
  );
  return (
    <section className="space-y-4">
      <form onSubmit={save} className={panelClass}>
        <p className="text-xs font-black uppercase tracking-widest text-cyan-300">
          {partyType === "supplier" ? "Supplier payment" : "Customer receipt"}{" "}
          with allocations
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <select
            aria-label="Party"
            required
            value={partyId}
            onChange={(event) => {
              setPartyId(event.target.value);
              setAllocations({});
            }}
            className={fieldClass}
          >
            <option value="">
              {partyType === "supplier" ? "Supplier" : "Customer"}
            </option>
            {parties.map((party) => (
              <option key={asText(party.id)} value={asText(party.id, "")}>
                {named(party)}
              </option>
            ))}
          </select>
          <input
            type="date"
            name="payment_date"
            required
            defaultValue={today()}
            className={fieldClass}
          />
          <input
            name="amount"
            required
            inputMode="decimal"
            placeholder="Total amount"
            className={fieldClass}
          />
          <select name="payment_account_id" required className={fieldClass}>
            <option value="">Cash / bank account</option>
            {accounts.map((account) => (
              <option key={asText(account.id)} value={asText(account.id, "")}>
                {asText(account.account_code)} · {asText(account.account_name)}
              </option>
            ))}
          </select>
          <select name="payment_mode" className={fieldClass}>
            <option value="cash">Cash</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="cheque">Cheque</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
          </select>
          <input
            name="reference_no"
            placeholder="Reference / cheque / UTR"
            className={fieldClass}
          />
          <input
            name="notes"
            placeholder="Notes"
            className={`${fieldClass} xl:col-span-3`}
          />
        </div>
        {partyId ? (
          <div className="space-y-2">
            <p className="text-xs font-black uppercase text-neutral-500">
              Allocate across open documents; any excess becomes a party advance
            </p>
            {matching.map((document) => (
              <label
                key={asText(document.id)}
                className="grid items-center gap-2 rounded-xl border border-white/10 p-3 text-sm md:grid-cols-[2fr_1fr_1fr]"
              >
                <span>
                  {asText(
                    document.supplier_invoice_number ??
                      document.display_invoice_number ??
                      document.invoice_number,
                  )}
                </span>
                <span className="font-mono">
                  Due {money(document.outstanding_minor)}
                </span>
                <input
                  aria-label={`Allocation for ${asText(document.supplier_invoice_number ?? document.invoice_number)}`}
                  inputMode="decimal"
                  min="0"
                  value={allocations[asText(document.id, "")] || ""}
                  onChange={(event) =>
                    setAllocations((current) => ({
                      ...current,
                      [asText(document.id, "")]: event.target.value,
                    }))
                  }
                  placeholder="Allocate amount"
                  className={fieldClass}
                />
              </label>
            ))}
          </div>
        ) : null}
        <button disabled={saving} className={buttonClass}>
          {saving ? "Posting…" : "Post settlement"}
        </button>
      </form>
      {advances.length ? (
        <AdvanceEditor
          partyType={partyType}
          advances={advances}
          documents={documents}
          saving={saving}
          onSubmit={onSubmit}
        />
      ) : null}
      <ExportActions
        view={
          partyType === "supplier" ? "supplier-payments" : "customer-receipts"
        }
        rows={rows}
      />
      <SmartTable rows={rows} />
    </section>
  );
}

function AdvanceEditor({
  partyType,
  advances,
  documents,
  saving,
  onSubmit,
}: {
  partyType: "supplier" | "customer";
  advances: Row[];
  documents: Row[];
  saving: boolean;
  onSubmit: Submit;
}) {
  const [advanceId, setAdvanceId] = useState("");
  const advance = advances.find((row) => row.id === advanceId);
  const matching = documents.filter(
    (row) =>
      row[`${partyType}_id`] === advance?.party_id &&
      asNumber(row.outstanding_minor) > 0,
  );
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        await onSubmit("/api/accounting/advances/apply", {
          ...Object.fromEntries(new FormData(form).entries()),
          party_type: partyType,
        });
        form.reset();
        setAdvanceId("");
      }}
      className="grid gap-3 rounded-lg border border-emerald-300/15 bg-emerald-300/5 p-4 md:grid-cols-4"
    >
      <select
        name="advance_id"
        required
        value={advanceId}
        onChange={(event) => setAdvanceId(event.target.value)}
        className={fieldClass}
      >
        <option value="">Open advance</option>
        {advances.map((row) => (
          <option key={asText(row.id)} value={asText(row.id, "")}>
            {money(asNumber(row.advance_minor) - asNumber(row.applied_minor))}{" "}
            available
          </option>
        ))}
      </select>
      <select name="document_id" required className={fieldClass}>
        <option value="">Target document</option>
        {matching.map((row) => (
          <option key={asText(row.id)} value={asText(row.id, "")}>
            {asText(row.supplier_invoice_number ?? row.invoice_number)} ·{" "}
            {money(row.outstanding_minor)}
          </option>
        ))}
      </select>
      <input
        name="amount"
        required
        inputMode="decimal"
        placeholder="Amount to apply"
        className={fieldClass}
      />
      <button disabled={saving} className={buttonClass}>
        Apply advance
      </button>
    </form>
  );
}

function SupplierEditor({
  rows,
  saving,
  onSubmit,
}: {
  rows: Row[];
  saving: boolean;
  onSubmit: Submit;
}) {
  return (
    <section className="space-y-4">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          await onSubmit(
            "/api/suppliers/save",
            Object.fromEntries(new FormData(form).entries()),
          );
          form.reset();
        }}
        className={`${panelClass} grid gap-3 md:grid-cols-3 xl:grid-cols-6`}
      >
        <input
          name="name"
          required
          placeholder="Supplier name"
          className={fieldClass}
        />
        <input
          name="contact_person"
          placeholder="Contact person"
          className={fieldClass}
        />
        <input name="phone" placeholder="Phone" className={fieldClass} />
        <input
          name="email"
          type="email"
          placeholder="Email"
          className={fieldClass}
        />
        <input
          name="gstin"
          maxLength={15}
          placeholder="GSTIN (checksum validated)"
          className={fieldClass}
        />
        <input
          name="pan"
          maxLength={10}
          placeholder="PAN"
          className={fieldClass}
        />
        <input
          name="billing_address"
          placeholder="Billing address"
          className={`${fieldClass} md:col-span-2`}
        />
        <input name="city" placeholder="City" className={fieldClass} />
        <input name="state" placeholder="State" className={fieldClass} />
        <input name="pin_code" placeholder="PIN code" className={fieldClass} />
        <input
          name="payment_terms"
          placeholder="Payment terms"
          className={fieldClass}
        />
        <input
          name="credit_days"
          inputMode="numeric"
          placeholder="Credit days"
          className={fieldClass}
        />
        <input
          name="opening_balance"
          inputMode="decimal"
          placeholder="Opening balance"
          className={fieldClass}
        />
        <select name="opening_balance_type" className={fieldClass}>
          <option value="payable">Opening payable</option>
          <option value="advance">Opening advance</option>
        </select>
        <input
          type="date"
          name="opening_date"
          defaultValue={today()}
          className={fieldClass}
        />
        <input
          name="notes"
          placeholder="Notes"
          className={`${fieldClass} md:col-span-2`}
        />
        <button disabled={saving} className={buttonClass}>
          Save supplier
        </button>
      </form>
      <ExportActions view="suppliers" rows={rows} />
      <SmartTable rows={rows} />
    </section>
  );
}

function BankAccountEditor({
  rows,
  saving,
  onSubmit,
}: {
  rows: Row[];
  saving: boolean;
  onSubmit: Submit;
}) {
  return (
    <section className="space-y-4">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          await onSubmit(
            "/api/accounting/bank-accounts/save",
            Object.fromEntries(new FormData(form).entries()),
          );
          form.reset();
        }}
        className={`${panelClass} grid gap-3 md:grid-cols-3 xl:grid-cols-6`}
      >
        <input
          name="bank_name"
          required
          placeholder="Bank name"
          className={fieldClass}
        />
        <input
          name="account_holder"
          placeholder="Account holder"
          className={fieldClass}
        />
        <input
          name="account_number"
          autoComplete="off"
          placeholder="Account number (shown masked)"
          className={fieldClass}
        />
        <input name="ifsc_code" placeholder="IFSC" className={fieldClass} />
        <input name="branch_name" placeholder="Branch" className={fieldClass} />
        <select name="account_type" className={fieldClass}>
          <option value="CURRENT">Current</option>
          <option value="SAVINGS">Savings</option>
          <option value="OD">Overdraft</option>
          <option value="CASH_CREDIT">Cash credit</option>
        </select>
        <input
          name="opening_balance"
          inputMode="decimal"
          placeholder="Opening balance"
          className={fieldClass}
        />
        <select name="opening_balance_type" className={fieldClass}>
          <option value="debit">Debit opening</option>
          <option value="credit">Credit opening</option>
        </select>
        <input
          type="date"
          name="opening_date"
          defaultValue={today()}
          className={fieldClass}
        />
        <input
          name="notes"
          placeholder="Notes"
          className={`${fieldClass} md:col-span-2`}
        />
        <button disabled={saving} className={buttonClass}>
          Save bank account
        </button>
      </form>
      <SmartTable rows={rows} />
    </section>
  );
}

function ReconciliationEditor({
  rows,
  reference,
  saving,
  onSubmit,
}: {
  rows: Row[];
  reference: Reference;
  saving: boolean;
  onSubmit: Submit;
}) {
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/5 p-4 text-sm text-neutral-300">
        <strong className="text-cyan-100">Metadata only:</strong> clearing a
        line records bank-statement status, date, and reference. It never posts
        or alters the accounting journal.
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit(
            "/api/accounting/bank-reconciliation/save",
            Object.fromEntries(new FormData(event.currentTarget).entries()),
          );
        }}
        className="grid gap-3 rounded-lg border border-white/10 p-4 md:grid-cols-5"
      >
        <select
          name="voucher_entry_id"
          required
          className={`${fieldClass} md:col-span-2`}
        >
          <option value="">Book transaction</option>
          {rows.map((row) => (
            <option
              key={asText(row.voucher_entry_id)}
              value={asText(row.voucher_entry_id, "")}
            >
              {asText(row.transaction_date)} · {asText(row.description)} ·{" "}
              {money(row.book_amount_minor)}
            </option>
          ))}
        </select>
        <select name="bank_account_id" required className={fieldClass}>
          <option value="">Bank account</option>
          {reference.bankAccounts.map((bank) => (
            <option key={asText(bank.id)} value={asText(bank.id, "")}>
              {asText(bank.display_name)}
            </option>
          ))}
        </select>
        <select name="status" className={fieldClass}>
          <option value="CLEARED">Cleared</option>
          <option value="UNRECONCILED">Unreconciled</option>
          <option value="REVIEW">Review / mismatch</option>
        </select>
        <input type="date" name="cleared_date" className={fieldClass} />
        <input
          name="bank_reference"
          placeholder="Bank reference"
          className={fieldClass}
        />
        <input
          name="notes"
          placeholder="Notes"
          className={`${fieldClass} md:col-span-3`}
        />
        <button disabled={saving} className={buttonClass}>
          Save reconciliation
        </button>
      </form>
      <ExportActions view="bank-reconciliation" rows={rows} />
      <SmartTable rows={rows} />
    </section>
  );
}

function CreditNoteEditor({
  rows,
  reference,
  saving,
  onSubmit,
}: {
  rows: Row[];
  reference: Reference;
  saving: boolean;
  onSubmit: Submit;
}) {
  const [invoiceId, setInvoiceId] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const items = reference.salesItems.filter(
    (row) => row.invoice_id === invoiceId,
  );
  return (
    <section className="space-y-4">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          await onSubmit("/api/sales/returns/create", {
            ...Object.fromEntries(new FormData(form).entries()),
            invoice_id: invoiceId,
            items: items.flatMap((item) =>
              asNumber(quantities[asText(item.id, "")]) > 0
                ? [
                    {
                      invoice_item_id: item.id,
                      product_id: item.product_id,
                      quantity: quantities[asText(item.id, "")],
                    },
                  ]
                : [],
            ),
          });
          form.reset();
          setInvoiceId("");
          setQuantities({});
        }}
        className={panelClass}
      >
        <div className="grid gap-3 md:grid-cols-4">
          <select
            aria-label="Original sales invoice"
            required
            value={invoiceId}
            onChange={(event) => {
              setInvoiceId(event.target.value);
              setQuantities({});
            }}
            className={fieldClass}
          >
            <option value="">Original sales invoice</option>
            {reference.salesInvoices.map((invoice) => (
              <option key={asText(invoice.id)} value={asText(invoice.id, "")}>
                {asText(
                  invoice.display_invoice_number ?? invoice.invoice_number,
                )}{" "}
                ·{" "}
                {asText(
                  reference.customers.find(
                    (customer) => customer.id === invoice.customer_id,
                  )?.name,
                )}
              </option>
            ))}
          </select>
          <input
            name="note_number"
            required
            placeholder="Credit note number"
            className={fieldClass}
          />
          <input
            type="date"
            name="note_date"
            required
            defaultValue={today()}
            className={fieldClass}
          />
          <input
            name="reason"
            required
            placeholder="Return / adjustment reason"
            className={fieldClass}
          />
        </div>
        {items.map((item) => (
          <label
            key={asText(item.id)}
            className="grid items-center gap-3 rounded-xl border border-white/10 p-3 md:grid-cols-[2fr_1fr_1fr]"
          >
            <span>{asText(item.product_name ?? item.description)}</span>
            <span>Sold {asText(item.quantity)}</span>
            <input
              aria-label={`Return quantity for ${asText(item.product_name)}`}
              inputMode="decimal"
              min="0"
              max={asNumber(item.quantity)}
              value={quantities[asText(item.id, "")] || ""}
              onChange={(event) =>
                setQuantities((current) => ({
                  ...current,
                  [asText(item.id, "")]: event.target.value,
                }))
              }
              placeholder="Return quantity"
              className={fieldClass}
            />
          </label>
        ))}
        <button disabled={saving} className={buttonClass}>
          Post credit note and stock return
        </button>
      </form>
      <ExportActions view="credit-notes" rows={rows} />
      <SmartTable rows={rows} />
    </section>
  );
}

function PeriodLockEditor({
  rows,
  saving,
  onSubmit,
}: {
  rows: Row[];
  saving: boolean;
  onSubmit: Submit;
}) {
  const active = rows.find((row) => !row.unlocked_at);
  return (
    <section className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            await onSubmit(
              "/api/accounting/period-lock",
              Object.fromEntries(new FormData(event.currentTarget).entries()),
            );
          }}
          className={panelClass}
        >
          <p className="font-black">Lock posted history</p>
          <input
            type="date"
            name="locked_through"
            required
            className={`${fieldClass} w-full`}
          />
          <input
            name="reason"
            required
            placeholder="Lock reason"
            className={`${fieldClass} w-full`}
          />
          <button disabled={saving} className={buttonClass}>
            Lock through date
          </button>
        </form>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            await onSubmit("/api/accounting/period-unlock", {
              ...Object.fromEntries(
                new FormData(event.currentTarget).entries(),
              ),
              lock_id: active?.id,
            });
          }}
          className={`${panelClass} border-amber-300/20`}
        >
          <p className="font-black">Controlled unlock</p>
          <p className="text-sm text-neutral-500">
            Active:{" "}
            {active ? `through ${asText(active.locked_through)}` : "none"}
          </p>
          <input
            name="reason"
            required
            placeholder="Required audit reason"
            className={`${fieldClass} w-full`}
          />
          <input
            name="confirmation"
            required
            placeholder="Type UNLOCK BOOKS"
            className={`${fieldClass} w-full`}
          />
          <button
            disabled={saving || !active}
            className="min-h-10 rounded-xl border border-amber-300/30 px-4 text-sm font-black text-amber-100 disabled:opacity-35"
          >
            Unlock with audit trail
          </button>
        </form>
      </div>
      <SmartTable rows={rows} />
    </section>
  );
}

function GstOverview({ report }: { report: Report }) {
  const metrics = [
    ["Taxable outward", report.taxableOutwardMinor],
    ["Output CGST", report.outputCgstMinor],
    ["Output SGST", report.outputSgstMinor],
    ["Output IGST", report.outputIgstMinor],
    ["Eligible input CGST", report.inputCgstMinor],
    ["Eligible input SGST", report.inputSgstMinor],
    ["Eligible input IGST", report.inputIgstMinor],
    ["Estimated net GST", report.netGstMinor],
  ];
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-amber-300/20 bg-amber-300/5 p-4 text-sm">
        <strong>GST Return Preparation</strong> — review classifications and
        validation warnings before using these figures for filing. This is not a
        direct filing workflow.
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value]) => (
          <article
            key={String(label)}
            className="rounded-lg border border-white/10 p-4"
          >
            <p className="text-[10px] font-black uppercase tracking-wider text-neutral-500">
              {String(label)}
            </p>
            <p className="mt-2 font-mono text-xl font-black">{money(value)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function GstrOne({ report }: { report: Report }) {
  const sections = report.sections as Row | undefined;
  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-amber-300/20 bg-amber-300/5 p-4 text-sm">
        <strong>GSTR-1 Preparation</strong> — review locally prepared B2B, B2C,
        note, and rate summaries. Nothing is submitted automatically.
      </div>
      {Object.entries(sections || {}).map(([name, value]) => (
        <article key={name} className="space-y-3">
          <h2 className="font-black uppercase tracking-wider">
            {name.replaceAll(/([A-Z])/g, " $1")}
          </h2>
          <SmartTable rows={Array.isArray(value) ? (value as Row[]) : []} />
        </article>
      ))}
    </section>
  );
}
