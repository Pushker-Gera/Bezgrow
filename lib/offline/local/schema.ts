"use client"

export const LOCAL_DB_VERSION = 21
export const LOCAL_DB_URL = "sqlite:bezgrow-offline.db"

export const normalizedTables = [
  "organizations",
  "business_settings",
  "financial_years",
  "financial_year_opening_balances",
  "financial_year_inventory_openings",
  "financial_year_invoice_sequences",
  "local_users",
  "roles",
  "permissions",
  "role_permissions",
  "organization_members",
  "feature_flags",
  "categories",
  "units",
  "products",
  "customers",
  "suppliers",
  "warehouses",
  "inventory_items",
  "stock_batches",
  "stock_movements",
  "sales_invoices",
  "sales_invoice_items",
  "purchase_invoices",
  "purchase_invoice_items",
  "orders",
  "order_items",
  "quotations",
  "quotation_items",
  "delivery_challans",
  "delivery_challan_items",
  "credit_notes",
  "credit_note_items",
  "debit_notes",
  "debit_note_items",
  "expenses",
  "payments",
  "payment_allocations",
  "party_advances",
  "advance_allocations",
  "payment_receipts",
  "ledger_entries",
  "chart_of_accounts",
  "accounting_vouchers",
  "accounting_voucher_entries",
  "accounting_settings",
  "accounting_sequences",
  "accounting_warnings",
  "bank_accounts",
  "bank_reconciliations",
  "accounting_period_locks",
  "gst_transaction_classifications",
  "purchase_attachments",
  "gst_tax_rates",
  "gst_invoice_summary",
  "gst_hsn_summary",
  "print_templates",
  "license_state",
  "device_activations",
  "local_audit_logs",
  "backup_manifest",
  "offline_sync_queue",
  "offline_sync_action_fields",
  "offline_sync_conflicts",
  "offline_sync_conflict_fields",
  "offline_sync_logs",
  "offline_sync_log_fields",
] as const

const commonSyncColumns = `
  sync_status TEXT NOT NULL DEFAULT 'synced',
  offline_local_id TEXT,
  server_id TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
`

function closedFinancialYearMutationTriggers(table: string, stem: string) {
  return (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => {
    const row = operation === "DELETE" ? "OLD" : "NEW"
    return `CREATE TRIGGER IF NOT EXISTS trg_fy_guard_${stem}_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table} FOR EACH ROW
      WHEN ${row}.financial_year_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM financial_years fy
        WHERE fy.id = ${row}.financial_year_id AND fy.organization_id = ${row}.organization_id AND fy.status <> 'OPEN'
      )
      BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`
  })
}

function closedFinancialYearChildTriggers(childTable: string, parentTable: string, foreignKey: string, stem: string) {
  return (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => {
    const row = operation === "DELETE" ? "OLD" : "NEW"
    return `CREATE TRIGGER IF NOT EXISTS trg_fy_guard_${stem}_${operation.toLowerCase()}
      BEFORE ${operation} ON ${childTable} FOR EACH ROW
      WHEN EXISTS (
        SELECT 1 FROM ${parentTable} parent
        JOIN financial_years fy ON fy.id = parent.financial_year_id AND fy.organization_id = parent.organization_id
        WHERE parent.id = ${row}.${foreignKey} AND parent.organization_id = ${row}.organization_id AND fy.status <> 'OPEN'
      )
      BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`
  })
}

function financialYearDateAssignmentTriggers(table: string, stem: string, dateExpression: string) {
  return (["INSERT", "UPDATE"] as const).map((operation) => {
    const expression = dateExpression.replaceAll("ROW", "NEW")
    return `CREATE TRIGGER IF NOT EXISTS trg_fy_date_${stem}_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table} FOR EACH ROW
      WHEN NEW.financial_year_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM financial_years fy
        WHERE fy.id = NEW.financial_year_id AND fy.organization_id = NEW.organization_id
          AND date(${expression}) BETWEEN date(fy.start_date) AND date(fy.end_date)
      )
      BEGIN SELECT RAISE(ABORT, 'financial_year_date_mismatch'); END`
  })
}

export const localMigrations: Array<{ version: number; name: string; sql: string[] }> = [
  {
    version: 1,
    name: "normalized_offline_erp_foundation",
    sql: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS database_health (
        id TEXT PRIMARY KEY,
        check_name TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        checked_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        name TEXT NOT NULL DEFAULT 'Business',
        business_name TEXT,
        industry TEXT,
        business_type TEXT,
        business_category TEXT,
        gst_number TEXT,
        tax_id TEXT,
        phone TEXT,
        email TEXT,
        website TEXT,
        fssai TEXT,
        address TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        currency TEXT NOT NULL DEFAULT 'INR',
        timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
        locale TEXT NOT NULL DEFAULT 'en-IN',
        branch_name TEXT DEFAULT 'Main Branch',
        invoice_prefix TEXT,
        next_invoice_number INTEGER NOT NULL DEFAULT 1,
        financial_year_start TEXT,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS business_settings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value_text TEXT,
        value_number REAL,
        value_boolean INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, key)
      )`,
      `CREATE TABLE IF NOT EXISTS local_users (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        email TEXT,
        full_name TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        approved INTEGER NOT NULL DEFAULT 1,
        business_created INTEGER NOT NULL DEFAULT 1,
        is_suspended INTEGER NOT NULL DEFAULT 0,
        last_login_at TEXT,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        label TEXT,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, name)
      )`,
      `CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        action TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (module, action)
      )`,
      `CREATE TABLE IF NOT EXISTS role_permissions (
        role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      )`,
      `CREATE TABLE IF NOT EXISTS organization_members (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        is_active INTEGER NOT NULL DEFAULT 1,
        ${commonSyncColumns},
        UNIQUE (organization_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS feature_flags (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        feature_key TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        requires_plan TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, feature_key)
      )`,
      `CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, name)
      )`,
      `CREATE TABLE IF NOT EXISTS units (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        symbol TEXT,
        precision INTEGER NOT NULL DEFAULT 2,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, name)
      )`,
      `CREATE TABLE IF NOT EXISTS suppliers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        gstin TEXT,
        gst_number TEXT,
        tax_id TEXT,
        address TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        opening_balance REAL NOT NULL DEFAULT 0,
        current_balance REAL NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS warehouses (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        code TEXT,
        address TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        ${commonSyncColumns},
        UNIQUE (organization_id, name)
      )`,
      `CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        manufacturer TEXT,
        sku TEXT,
        barcode TEXT,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        category TEXT,
        unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
        unit TEXT DEFAULT 'pcs',
        supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
        supplier TEXT,
        warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
        warehouse TEXT,
        hsn_code TEXT,
        price REAL NOT NULL DEFAULT 0,
        stock REAL NOT NULL DEFAULT 0,
        min_stock REAL NOT NULL DEFAULT 5,
        reserved_stock REAL NOT NULL DEFAULT 0,
        batch_no TEXT,
        mrp REAL,
        purchase_rate REAL,
        sale_rate REAL,
        gst REAL,
        expiry_date TEXT,
        purchase_date TEXT,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        gst_number TEXT,
        tax_id TEXT,
        address TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        customer_type TEXT NOT NULL DEFAULT 'retail',
        opening_balance REAL NOT NULL DEFAULT 0,
        current_balance REAL NOT NULL DEFAULT 0,
        total_sales REAL NOT NULL DEFAULT 0,
        last_purchase_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS inventory_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
        batch_id TEXT,
        quantity REAL NOT NULL DEFAULT 0,
        reserved_quantity REAL NOT NULL DEFAULT 0,
        available_quantity REAL NOT NULL DEFAULT 0,
        reorder_level REAL NOT NULL DEFAULT 0,
        ${commonSyncColumns},
        UNIQUE (organization_id, product_id, warehouse_id, batch_id)
      )`,
      `CREATE TABLE IF NOT EXISTS stock_batches (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
        batch_no TEXT,
        manufacturing_date TEXT,
        expiry_date TEXT,
        purchase_date TEXT,
        quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        purchase_rate REAL,
        mrp REAL,
        barcode TEXT,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        product_name TEXT,
        warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
        batch_id TEXT REFERENCES stock_batches(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 0,
        previous_stock REAL,
        new_stock REAL,
        reason TEXT,
        reference_no TEXT,
        reference_type TEXT,
        reference_id TEXT,
        movement_date TEXT NOT NULL DEFAULT (date('now')),
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS sales_invoices (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        customer_name TEXT,
        invoice_number TEXT NOT NULL,
        invoice_type TEXT NOT NULL DEFAULT 'standard',
        invoice_date TEXT NOT NULL DEFAULT (date('now')),
        date TEXT,
        due_date TEXT,
        subtotal REAL NOT NULL DEFAULT 0,
        discount_amount REAL NOT NULL DEFAULT 0,
        discount_total REAL NOT NULL DEFAULT 0,
        taxable_amount REAL NOT NULL DEFAULT 0,
        tax_amount REAL NOT NULL DEFAULT 0,
        tax_total REAL NOT NULL DEFAULT 0,
        total_amount REAL NOT NULL DEFAULT 0,
        grand_total REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        paid_amount REAL NOT NULL DEFAULT 0,
        outstanding_amount REAL NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'unpaid',
        status TEXT NOT NULL DEFAULT 'unpaid',
        payment_method TEXT DEFAULT 'cash',
        notes TEXT,
        shipping_code TEXT,
        courier_name TEXT,
        tracking_number TEXT,
        offline_client_id TEXT,
        ${commonSyncColumns},
        UNIQUE (organization_id, invoice_number)
      )`,
      `CREATE TABLE IF NOT EXISTS sales_invoice_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        invoice_id TEXT NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        product_name TEXT,
        description TEXT,
        hsn_code TEXT,
        quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        unit_price REAL NOT NULL DEFAULT 0,
        tax_percent REAL NOT NULL DEFAULT 0,
        discount_percent REAL NOT NULL DEFAULT 0,
        line_total REAL NOT NULL DEFAULT 0,
        gst_amount REAL NOT NULL DEFAULT 0,
        cgst_amount REAL NOT NULL DEFAULT 0,
        sgst_amount REAL NOT NULL DEFAULT 0,
        igst_amount REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'synced',
        offline_local_id TEXT,
        server_id TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_invoices (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
        supplier_name TEXT,
        invoice_kind TEXT NOT NULL DEFAULT 'purchase_invoice',
        purchase_order_id TEXT,
        return_against_id TEXT,
        goods_received_id TEXT,
        bill_number TEXT NOT NULL,
        bill_date TEXT NOT NULL DEFAULT (date('now')),
        due_date TEXT,
        subtotal REAL NOT NULL DEFAULT 0,
        discount_total REAL NOT NULL DEFAULT 0,
        taxable_amount REAL NOT NULL DEFAULT 0,
        tax_total REAL NOT NULL DEFAULT 0,
        grand_total REAL NOT NULL DEFAULT 0,
        received_status TEXT NOT NULL DEFAULT 'received',
        paid_amount REAL NOT NULL DEFAULT 0,
        outstanding_amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'unpaid',
        notes TEXT,
        ${commonSyncColumns},
        UNIQUE (organization_id, bill_number)
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_invoice_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        purchase_invoice_id TEXT NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        product_name TEXT,
        warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
        batch_no TEXT,
        expiry_date TEXT,
        quantity REAL NOT NULL DEFAULT 0,
        unit_cost REAL NOT NULL DEFAULT 0,
        tax_percent REAL NOT NULL DEFAULT 0,
        tax_amount REAL NOT NULL DEFAULT 0,
        line_total REAL NOT NULL DEFAULT 0,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        order_number TEXT NOT NULL,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        customer_name TEXT,
        customer_phone TEXT,
        customer_address TEXT,
        order_status TEXT,
        status TEXT,
        payment_status TEXT,
        payment_mode TEXT,
        sales_channel TEXT,
        courier_name TEXT,
        courier TEXT,
        tracking_number TEXT,
        total_amount REAL NOT NULL DEFAULT 0,
        grand_total REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        ${commonSyncColumns},
        UNIQUE (organization_id, order_number)
      )`,
      `CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        product_name TEXT,
        quantity REAL NOT NULL DEFAULT 0,
        unit_price REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'synced',
        offline_local_id TEXT,
        server_id TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS quotations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        quote_number TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        valid_until TEXT,
        subtotal REAL NOT NULL DEFAULT 0,
        discount_total REAL NOT NULL DEFAULT 0,
        tax_total REAL NOT NULL DEFAULT 0,
        grand_total REAL NOT NULL DEFAULT 0,
        notes TEXT,
        ${commonSyncColumns},
        UNIQUE (organization_id, quote_number)
      )`,
      `CREATE TABLE IF NOT EXISTS quotation_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        description TEXT,
        quantity REAL NOT NULL DEFAULT 0,
        unit_price REAL NOT NULL DEFAULT 0,
        tax_rate REAL NOT NULL DEFAULT 0,
        tax_amount REAL NOT NULL DEFAULT 0,
        line_total REAL NOT NULL DEFAULT 0,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS delivery_challans (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        challan_number TEXT NOT NULL,
        challan_date TEXT NOT NULL DEFAULT (date('now')),
        status TEXT NOT NULL DEFAULT 'draft',
        notes TEXT,
        ${commonSyncColumns},
        UNIQUE (organization_id, challan_number)
      )`,
      `CREATE TABLE IF NOT EXISTS delivery_challan_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        challan_id TEXT NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        description TEXT,
        quantity REAL NOT NULL DEFAULT 0,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS credit_notes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        invoice_id TEXT REFERENCES sales_invoices(id) ON DELETE SET NULL,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        note_number TEXT NOT NULL,
        note_date TEXT NOT NULL DEFAULT (date('now')),
        reason TEXT,
        subtotal REAL NOT NULL DEFAULT 0,
        tax_total REAL NOT NULL DEFAULT 0,
        grand_total REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        ${commonSyncColumns},
        UNIQUE (organization_id, note_number)
      )`,
      `CREATE TABLE IF NOT EXISTS credit_note_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        credit_note_id TEXT NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        quantity REAL NOT NULL DEFAULT 0,
        unit_price REAL NOT NULL DEFAULT 0,
        tax_amount REAL NOT NULL DEFAULT 0,
        line_total REAL NOT NULL DEFAULT 0,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS debit_notes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
        note_number TEXT NOT NULL,
        note_date TEXT NOT NULL DEFAULT (date('now')),
        reason TEXT,
        subtotal REAL NOT NULL DEFAULT 0,
        tax_total REAL NOT NULL DEFAULT 0,
        grand_total REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        ${commonSyncColumns},
        UNIQUE (organization_id, note_number)
      )`,
      `CREATE TABLE IF NOT EXISTS debit_note_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        debit_note_id TEXT NOT NULL REFERENCES debit_notes(id) ON DELETE CASCADE,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        quantity REAL NOT NULL DEFAULT 0,
        unit_price REAL NOT NULL DEFAULT 0,
        tax_amount REAL NOT NULL DEFAULT 0,
        line_total REAL NOT NULL DEFAULT 0,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS expenses (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
        category TEXT,
        description TEXT,
        amount REAL NOT NULL DEFAULT 0,
        tax_amount REAL NOT NULL DEFAULT 0,
        expense_date TEXT NOT NULL DEFAULT (date('now')),
        payment_status TEXT NOT NULL DEFAULT 'paid',
        paid_amount REAL NOT NULL DEFAULT 0,
        outstanding_amount REAL NOT NULL DEFAULT 0,
        payment_method TEXT,
        reference_no TEXT,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        party_type TEXT NOT NULL,
        party_id TEXT,
        document_type TEXT,
        document_id TEXT,
        amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
        direction TEXT,
        payment_method TEXT,
        reference_no TEXT,
        payment_date TEXT NOT NULL DEFAULT (date('now')),
        cleared_at TEXT,
        notes TEXT,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS payment_receipts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        invoice_id TEXT REFERENCES sales_invoices(id) ON DELETE SET NULL,
        receipt_number TEXT,
        receipt_type TEXT,
        amount REAL NOT NULL CHECK (amount > 0),
        payment_method TEXT,
        reference_no TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        notes TEXT,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        account_type TEXT NOT NULL,
        account_id TEXT,
        document_type TEXT NOT NULL,
        document_id TEXT,
        entry_date TEXT NOT NULL DEFAULT (date('now')),
        debit REAL NOT NULL DEFAULT 0,
        credit REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'INR',
        description TEXT,
        ${commonSyncColumns},
        CHECK (debit >= 0 AND credit >= 0)
      )`,
      `CREATE TABLE IF NOT EXISTS gst_tax_rates (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        rate REAL NOT NULL,
        label TEXT,
        hsn_code TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS gst_invoice_summary (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        invoice_id TEXT NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
        gst_rate REAL NOT NULL DEFAULT 0,
        taxable_amount REAL NOT NULL DEFAULT 0,
        cgst_amount REAL NOT NULL DEFAULT 0,
        sgst_amount REAL NOT NULL DEFAULT 0,
        igst_amount REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (invoice_id, gst_rate)
      )`,
      `CREATE TABLE IF NOT EXISTS gst_hsn_summary (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,
        hsn_code TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 0,
        taxable_amount REAL NOT NULL DEFAULT 0,
        tax_amount REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, period_key, hsn_code)
      )`,
      `CREATE TABLE IF NOT EXISTS print_templates (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        template_key TEXT NOT NULL,
        format TEXT NOT NULL,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        paper_width TEXT,
        font_size REAL,
        show_hsn INTEGER,
        show_tax_breakup INTEGER,
        show_signature INTEGER,
        show_qr INTEGER,
        show_barcode INTEGER,
        pharma_mode INTEGER,
        ${commonSyncColumns},
        UNIQUE (organization_id, template_key)
      )`,
      `CREATE TABLE IF NOT EXISTS license_state (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        license_key TEXT,
        customer_id TEXT,
        business_id TEXT,
        business_name TEXT,
        device_id TEXT,
        plan_code TEXT,
        plan_name TEXT,
        status TEXT NOT NULL DEFAULT 'trial',
        expiry_date TEXT,
        grace_period_days INTEGER NOT NULL DEFAULT 0,
        allowed_features TEXT,
        issued_by_admin TEXT,
        notes TEXT,
        issued_at TEXT,
        expires_at TEXT,
        grace_until TEXT,
        last_verified_at TEXT,
        signature TEXT,
        device_limit INTEGER,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS device_activations (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        license_id TEXT REFERENCES license_state(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        device_name TEXT,
        platform TEXT,
        activated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        ${commonSyncColumns},
        UNIQUE (license_id, device_id)
      )`,
      `CREATE TABLE IF NOT EXISTS local_audit_logs (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        description TEXT,
        previous_hash TEXT,
        hash TEXT,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        offline_local_id TEXT,
        server_id TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS backup_manifest (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        backup_name TEXT NOT NULL,
        storage_path TEXT,
        checksum TEXT,
        size_bytes INTEGER,
        table_count INTEGER,
        row_count INTEGER,
        verification_status TEXT,
        verified_at TEXT,
        integrity_report TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        restored_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS offline_sync_queue (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_synced_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS offline_sync_action_fields (
        action_id TEXT NOT NULL REFERENCES offline_sync_queue(id) ON DELETE CASCADE,
        field_path TEXT NOT NULL,
        value_text TEXT,
        value_number REAL,
        value_boolean INTEGER,
        value_type TEXT NOT NULL,
        PRIMARY KEY (action_id, field_path)
      )`,
      `CREATE TABLE IF NOT EXISTS offline_sync_conflicts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        local_id TEXT,
        server_id TEXT,
        message TEXT NOT NULL,
        resolution TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS offline_sync_conflict_fields (
        conflict_id TEXT NOT NULL REFERENCES offline_sync_conflicts(id) ON DELETE CASCADE,
        field_path TEXT NOT NULL,
        value_text TEXT,
        value_number REAL,
        value_boolean INTEGER,
        value_type TEXT NOT NULL,
        PRIMARY KEY (conflict_id, field_path)
      )`,
      `CREATE TABLE IF NOT EXISTS offline_sync_logs (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
        action_id TEXT REFERENCES offline_sync_queue(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS offline_sync_log_fields (
        log_id TEXT NOT NULL REFERENCES offline_sync_logs(id) ON DELETE CASCADE,
        field_path TEXT NOT NULL,
        value_text TEXT,
        value_number REAL,
        value_boolean INTEGER,
        value_type TEXT NOT NULL,
        PRIMARY KEY (log_id, field_path)
      )`,
    ],
  },
  {
    version: 2,
    name: "offline_erp_performance_indexes",
    sql: [
      "CREATE INDEX IF NOT EXISTS idx_products_org_name ON products (organization_id, name COLLATE NOCASE)",
      "CREATE INDEX IF NOT EXISTS idx_products_org_sku ON products (organization_id, sku)",
      "CREATE INDEX IF NOT EXISTS idx_products_org_barcode ON products (organization_id, barcode)",
      "CREATE INDEX IF NOT EXISTS idx_products_org_stock ON products (organization_id, stock, min_stock)",
      "CREATE INDEX IF NOT EXISTS idx_products_org_deleted ON products (organization_id, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_customers_org_name ON customers (organization_id, name COLLATE NOCASE)",
      "CREATE INDEX IF NOT EXISTS idx_customers_org_phone ON customers (organization_id, phone)",
      "CREATE INDEX IF NOT EXISTS idx_suppliers_org_name ON suppliers (organization_id, name COLLATE NOCASE)",
      "CREATE INDEX IF NOT EXISTS idx_inventory_product_warehouse ON inventory_items (organization_id, product_id, warehouse_id)",
      "CREATE INDEX IF NOT EXISTS idx_batches_product_expiry ON stock_batches (organization_id, product_id, expiry_date)",
      "CREATE INDEX IF NOT EXISTS idx_movements_org_product_date ON stock_movements (organization_id, product_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_movements_org_ref ON stock_movements (organization_id, reference_no)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_created ON sales_invoices (organization_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_number ON sales_invoices (organization_id, invoice_number)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_customer ON sales_invoices (organization_id, customer_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_status ON sales_invoices (organization_id, payment_status, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sales_items_invoice ON sales_invoice_items (organization_id, invoice_id)",
      "CREATE INDEX IF NOT EXISTS idx_sales_items_product ON sales_invoice_items (organization_id, product_id)",
      "CREATE INDEX IF NOT EXISTS idx_purchase_invoices_org_created ON purchase_invoices (organization_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_orders_org_created ON orders (organization_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_orders_org_number ON orders (organization_id, order_number)",
      "CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (organization_id, order_id)",
      "CREATE INDEX IF NOT EXISTS idx_ledger_org_date ON ledger_entries (organization_id, entry_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_ledger_org_account ON ledger_entries (organization_id, account_type, account_id)",
      "CREATE INDEX IF NOT EXISTS idx_expenses_org_date ON expenses (organization_id, expense_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_receipts_org_invoice ON payment_receipts (organization_id, invoice_id)",
      "CREATE INDEX IF NOT EXISTS idx_audit_org_created ON local_audit_logs (organization_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON offline_sync_queue (status, datetime(created_at))",
      "CREATE INDEX IF NOT EXISTS idx_sync_queue_org ON offline_sync_queue (organization_id, status)",
      "CREATE INDEX IF NOT EXISTS idx_backup_org_created ON backup_manifest (organization_id, datetime(created_at) DESC)",
    ],
  },
  {
    version: 3,
    name: "offline_erp_sync_column_completion",
    sql: [
      "ALTER TABLE local_users ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE",
      "ALTER TABLE sales_invoices ADD COLUMN offline_client_id TEXT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'",
      "ALTER TABLE purchase_invoice_items ADD COLUMN offline_local_id TEXT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN server_id TEXT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN last_synced_at TEXT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN deleted_at TEXT",
      "ALTER TABLE quotation_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'",
      "ALTER TABLE quotation_items ADD COLUMN offline_local_id TEXT",
      "ALTER TABLE quotation_items ADD COLUMN server_id TEXT",
      "ALTER TABLE quotation_items ADD COLUMN last_synced_at TEXT",
      "ALTER TABLE quotation_items ADD COLUMN deleted_at TEXT",
      "ALTER TABLE delivery_challan_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'",
      "ALTER TABLE delivery_challan_items ADD COLUMN offline_local_id TEXT",
      "ALTER TABLE delivery_challan_items ADD COLUMN server_id TEXT",
      "ALTER TABLE delivery_challan_items ADD COLUMN last_synced_at TEXT",
      "ALTER TABLE delivery_challan_items ADD COLUMN deleted_at TEXT",
      "ALTER TABLE credit_note_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'",
      "ALTER TABLE credit_note_items ADD COLUMN offline_local_id TEXT",
      "ALTER TABLE credit_note_items ADD COLUMN server_id TEXT",
      "ALTER TABLE credit_note_items ADD COLUMN last_synced_at TEXT",
      "ALTER TABLE credit_note_items ADD COLUMN deleted_at TEXT",
      "ALTER TABLE debit_note_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'",
      "ALTER TABLE debit_note_items ADD COLUMN offline_local_id TEXT",
      "ALTER TABLE debit_note_items ADD COLUMN server_id TEXT",
      "ALTER TABLE debit_note_items ADD COLUMN last_synced_at TEXT",
      "ALTER TABLE debit_note_items ADD COLUMN deleted_at TEXT",
      "ALTER TABLE license_state ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'",
      "ALTER TABLE license_state ADD COLUMN offline_local_id TEXT",
      "ALTER TABLE license_state ADD COLUMN server_id TEXT",
      "ALTER TABLE license_state ADD COLUMN last_synced_at TEXT",
      "ALTER TABLE license_state ADD COLUMN created_at TEXT",
      "ALTER TABLE license_state ADD COLUMN deleted_at TEXT",
      "ALTER TABLE device_activations ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'",
      "ALTER TABLE device_activations ADD COLUMN offline_local_id TEXT",
      "ALTER TABLE device_activations ADD COLUMN server_id TEXT",
      "ALTER TABLE device_activations ADD COLUMN last_synced_at TEXT",
      "ALTER TABLE device_activations ADD COLUMN created_at TEXT",
      "ALTER TABLE device_activations ADD COLUMN updated_at TEXT",
      "ALTER TABLE device_activations ADD COLUMN deleted_at TEXT",
      "ALTER TABLE local_audit_logs ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'",
      "ALTER TABLE local_audit_logs ADD COLUMN offline_local_id TEXT",
      "ALTER TABLE local_audit_logs ADD COLUMN server_id TEXT",
      "ALTER TABLE local_audit_logs ADD COLUMN last_synced_at TEXT",
      "ALTER TABLE local_audit_logs ADD COLUMN updated_at TEXT",
      "ALTER TABLE local_audit_logs ADD COLUMN deleted_at TEXT",
      "ALTER TABLE print_templates ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'",
      "ALTER TABLE print_templates ADD COLUMN offline_local_id TEXT",
      "ALTER TABLE print_templates ADD COLUMN server_id TEXT",
      "ALTER TABLE print_templates ADD COLUMN last_synced_at TEXT",
      "ALTER TABLE print_templates ADD COLUMN created_at TEXT",
      "ALTER TABLE print_templates ADD COLUMN deleted_at TEXT",
      "CREATE INDEX IF NOT EXISTS idx_purchase_items_invoice ON purchase_invoice_items (organization_id, purchase_invoice_id)",
      "CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_invoice_items (organization_id, product_id)",
      "CREATE INDEX IF NOT EXISTS idx_payments_org_document ON payments (organization_id, document_type, document_id)",
      "CREATE INDEX IF NOT EXISTS idx_quotations_org_created ON quotations (organization_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_challans_org_created ON delivery_challans (organization_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_credit_notes_org_created ON credit_notes (organization_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_debit_notes_org_created ON debit_notes (organization_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_license_org_status ON license_state (organization_id, status)",
    ],
  },
  {
    version: 4,
    name: "professional_offline_erp_completion",
    sql: [
      "ALTER TABLE sales_invoices ADD COLUMN paid_amount REAL NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoices ADD COLUMN outstanding_amount REAL NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN invoice_kind TEXT NOT NULL DEFAULT 'purchase_invoice'",
      "ALTER TABLE purchase_invoices ADD COLUMN purchase_order_id TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN return_against_id TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN goods_received_id TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN received_status TEXT NOT NULL DEFAULT 'received'",
      "ALTER TABLE purchase_invoices ADD COLUMN paid_amount REAL NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN outstanding_amount REAL NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL",
      "ALTER TABLE purchase_invoice_items ADD COLUMN batch_no TEXT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN expiry_date TEXT",
      "ALTER TABLE payments ADD COLUMN direction TEXT",
      "ALTER TABLE payments ADD COLUMN cleared_at TEXT",
      "ALTER TABLE payment_receipts ADD COLUMN receipt_type TEXT",
      "ALTER TABLE expenses ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'paid'",
      "ALTER TABLE expenses ADD COLUMN paid_amount REAL NOT NULL DEFAULT 0",
      "ALTER TABLE expenses ADD COLUMN outstanding_amount REAL NOT NULL DEFAULT 0",
      "ALTER TABLE backup_manifest ADD COLUMN verification_status TEXT",
      "ALTER TABLE backup_manifest ADD COLUMN verified_at TEXT",
      "ALTER TABLE backup_manifest ADD COLUMN integrity_report TEXT",
      "CREATE INDEX IF NOT EXISTS idx_sales_report_org_date ON sales_invoices (organization_id, invoice_date DESC, payment_status)",
      "CREATE INDEX IF NOT EXISTS idx_sales_outstanding ON sales_invoices (organization_id, outstanding_amount, customer_id)",
      "CREATE INDEX IF NOT EXISTS idx_purchase_report_org_date ON purchase_invoices (organization_id, bill_date DESC, invoice_kind, status)",
      "CREATE INDEX IF NOT EXISTS idx_purchase_outstanding ON purchase_invoices (organization_id, outstanding_amount, supplier_id)",
      "CREATE INDEX IF NOT EXISTS idx_expense_report_org_category_date ON expenses (organization_id, category, expense_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_payments_org_party_date ON payments (organization_id, party_type, party_id, payment_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_receipts_org_customer_date ON payment_receipts (organization_id, customer_id, received_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_stock_movements_org_type_date ON stock_movements (organization_id, type, movement_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_ledger_org_doc ON ledger_entries (organization_id, document_type, document_id)",
      "CREATE INDEX IF NOT EXISTS idx_ledger_org_doc_account ON ledger_entries (organization_id, document_type, document_id, account_type, account_id)",
      "CREATE INDEX IF NOT EXISTS idx_gst_invoice_summary_org_rate ON gst_invoice_summary (organization_id, gst_rate)",
      "CREATE INDEX IF NOT EXISTS idx_backup_verification ON backup_manifest (organization_id, verification_status, verified_at)",
    ],
  },
  {
    version: 5,
    name: "admin_issued_offline_license_activation",
    sql: [
      "ALTER TABLE license_state ADD COLUMN customer_id TEXT",
      "ALTER TABLE license_state ADD COLUMN business_id TEXT",
      "ALTER TABLE license_state ADD COLUMN business_name TEXT",
      "ALTER TABLE license_state ADD COLUMN device_id TEXT",
      "ALTER TABLE license_state ADD COLUMN plan_name TEXT",
      "ALTER TABLE license_state ADD COLUMN expiry_date TEXT",
      "ALTER TABLE license_state ADD COLUMN grace_period_days INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE license_state ADD COLUMN allowed_features TEXT",
      "ALTER TABLE license_state ADD COLUMN issued_by_admin TEXT",
      "ALTER TABLE license_state ADD COLUMN notes TEXT",
      "CREATE INDEX IF NOT EXISTS idx_license_org_device_status ON license_state (organization_id, device_id, status)",
      "CREATE INDEX IF NOT EXISTS idx_license_org_expiry ON license_state (organization_id, expiry_date, grace_until)",
      "CREATE INDEX IF NOT EXISTS idx_device_activation_device ON device_activations (device_id, is_active)",
    ],
  },
  {
    version: 6,
    name: "international_accounting_and_reporting_completion",
    sql: [
      `CREATE TABLE IF NOT EXISTS chart_of_accounts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        account_code TEXT NOT NULL,
        account_name TEXT NOT NULL,
        account_type TEXT NOT NULL,
        account_group TEXT,
        parent_id TEXT REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
        normal_balance TEXT NOT NULL DEFAULT 'debit',
        opening_balance REAL NOT NULL DEFAULT 0,
        current_balance REAL NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        is_cash_account INTEGER NOT NULL DEFAULT 0,
        is_bank_account INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        ${commonSyncColumns},
        UNIQUE (organization_id, account_code),
        UNIQUE (organization_id, account_name)
      )`,
      `CREATE TABLE IF NOT EXISTS bank_accounts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        account_id TEXT REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
        bank_name TEXT NOT NULL,
        branch_name TEXT,
        account_number TEXT,
        ifsc_code TEXT,
        account_holder TEXT,
        opening_balance REAL NOT NULL DEFAULT 0,
        current_balance REAL NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        ${commonSyncColumns}
      )`,
      `CREATE TABLE IF NOT EXISTS accounting_vouchers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        voucher_number TEXT NOT NULL,
        voucher_type TEXT NOT NULL,
        voucher_date TEXT NOT NULL DEFAULT (date('now')),
        reference_no TEXT,
        narration TEXT,
        total_debit REAL NOT NULL DEFAULT 0,
        total_credit REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'posted',
        ${commonSyncColumns},
        UNIQUE (organization_id, voucher_number)
      )`,
      `CREATE TABLE IF NOT EXISTS accounting_voucher_entries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        voucher_id TEXT NOT NULL REFERENCES accounting_vouchers(id) ON DELETE CASCADE,
        account_id TEXT REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
        account_type TEXT NOT NULL,
        party_type TEXT,
        party_id TEXT,
        line_no INTEGER NOT NULL DEFAULT 1,
        debit REAL NOT NULL DEFAULT 0,
        credit REAL NOT NULL DEFAULT 0,
        description TEXT,
        ${commonSyncColumns},
        CHECK (debit >= 0 AND credit >= 0)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_chart_accounts_org_type ON chart_of_accounts (organization_id, account_type, is_active)",
      "CREATE INDEX IF NOT EXISTS idx_chart_accounts_org_group ON chart_of_accounts (organization_id, account_group, account_name COLLATE NOCASE)",
      "CREATE INDEX IF NOT EXISTS idx_bank_accounts_org_active ON bank_accounts (organization_id, is_active)",
      "CREATE INDEX IF NOT EXISTS idx_vouchers_org_date_type ON accounting_vouchers (organization_id, voucher_date DESC, voucher_type)",
      "CREATE INDEX IF NOT EXISTS idx_voucher_entries_voucher ON accounting_voucher_entries (organization_id, voucher_id, line_no)",
      "CREATE INDEX IF NOT EXISTS idx_voucher_entries_account ON accounting_voucher_entries (organization_id, account_id)",
      "CREATE INDEX IF NOT EXISTS idx_ledger_org_account_date ON ledger_entries (organization_id, account_type, account_id, entry_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sales_items_hsn ON sales_invoice_items (organization_id, hsn_code, tax_percent)",
      "CREATE INDEX IF NOT EXISTS idx_purchase_items_hsn ON purchase_invoice_items (organization_id, product_id, tax_percent)",
      "CREATE INDEX IF NOT EXISTS idx_stock_batches_barcode ON stock_batches (organization_id, barcode)",
    ],
  },
  {
    version: 7,
    name: "desktop_list_and_mutation_hardening",
    sql: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_products_org_sku_unique ON products (organization_id, sku COLLATE NOCASE) WHERE sku IS NOT NULL AND trim(sku) <> '' AND deleted_at IS NULL",
      "CREATE INDEX IF NOT EXISTS idx_products_org_active_created ON products (organization_id, deleted_at, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_products_org_category_supplier ON products (organization_id, category, supplier, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_customers_org_active_created ON customers (organization_id, deleted_at, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_customers_org_filters ON customers (organization_id, is_active, customer_type, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_customers_org_email ON customers (organization_id, email COLLATE NOCASE)",
      "CREATE INDEX IF NOT EXISTS idx_customers_org_gst ON customers (organization_id, gst_number COLLATE NOCASE)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_active_created ON sales_invoices (organization_id, deleted_at, created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_filters ON sales_invoices (organization_id, payment_status, customer_id, invoice_date DESC, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_sales_items_invoice_active ON sales_invoice_items (organization_id, invoice_id, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_feature_flags_org_key_enabled ON feature_flags (organization_id, feature_key, is_enabled)",
    ],
  },
  {
    version: 8,
    name: "offline_business_logo_print_settings_and_export_indexes",
    sql: [
      "ALTER TABLE organizations ADD COLUMN logo_path TEXT",
      "ALTER TABLE organizations ADD COLUMN logo_mime_type TEXT",
      "ALTER TABLE organizations ADD COLUMN logo_width INTEGER",
      "ALTER TABLE organizations ADD COLUMN logo_height INTEGER",
      "ALTER TABLE organizations ADD COLUMN logo_updated_at TEXT",
      "CREATE INDEX IF NOT EXISTS idx_organizations_updated ON organizations (datetime(updated_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_products_org_updated ON products (organization_id, datetime(updated_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_customers_org_updated ON customers (organization_id, datetime(updated_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_invoice_date ON sales_invoices (organization_id, invoice_date DESC, invoice_number)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_updated ON sales_invoices (organization_id, datetime(updated_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_stock_movements_org_created ON stock_movements (organization_id, datetime(created_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_stock_movements_org_updated ON stock_movements (organization_id, datetime(updated_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_orders_org_updated ON orders (organization_id, datetime(updated_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_suppliers_org_updated ON suppliers (organization_id, datetime(updated_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_payments_org_updated ON payments (organization_id, datetime(updated_at) DESC)",
      "CREATE INDEX IF NOT EXISTS idx_expenses_org_updated ON expenses (organization_id, datetime(updated_at) DESC)",
    ],
  },
  {
    version: 9,
    name: "invoice_item_product_snapshot_fields",
    sql: [
      "ALTER TABLE sales_invoice_items ADD COLUMN batch_no TEXT",
      "ALTER TABLE sales_invoice_items ADD COLUMN expiry_date TEXT",
      "ALTER TABLE sales_invoice_items ADD COLUMN unit TEXT",
      "ALTER TABLE sales_invoice_items ADD COLUMN mrp REAL",
      `UPDATE sales_invoice_items
       SET batch_no = COALESCE(NULLIF(trim(batch_no), ''), (SELECT p.batch_no FROM products p WHERE p.id = sales_invoice_items.product_id AND p.organization_id = sales_invoice_items.organization_id)),
           expiry_date = COALESCE(NULLIF(trim(expiry_date), ''), (SELECT p.expiry_date FROM products p WHERE p.id = sales_invoice_items.product_id AND p.organization_id = sales_invoice_items.organization_id)),
           hsn_code = COALESCE(NULLIF(trim(hsn_code), ''), (SELECT p.hsn_code FROM products p WHERE p.id = sales_invoice_items.product_id AND p.organization_id = sales_invoice_items.organization_id)),
           unit = COALESCE(NULLIF(trim(unit), ''), (SELECT p.unit FROM products p WHERE p.id = sales_invoice_items.product_id AND p.organization_id = sales_invoice_items.organization_id)),
           mrp = COALESCE(mrp, (SELECT p.mrp FROM products p WHERE p.id = sales_invoice_items.product_id AND p.organization_id = sales_invoice_items.organization_id))`,
      "CREATE INDEX IF NOT EXISTS idx_sales_items_batch_expiry ON sales_invoice_items (organization_id, batch_no, expiry_date)",
    ],
  },
  {
    version: 10,
    name: "customer_gst_state_fields",
    sql: [
      "ALTER TABLE customers ADD COLUMN state_code TEXT",
      "CREATE INDEX IF NOT EXISTS idx_customers_org_state ON customers (organization_id, state_code, state)",
    ],
  },
  {
    version: 11,
    name: "stable_workspace_joined_date",
    sql: [
      "ALTER TABLE organizations ADD COLUMN joined_at TEXT",
      `UPDATE organizations
       SET joined_at = COALESCE(
         (SELECT MIN(candidate)
          FROM (
            SELECT NULLIF(trim(organizations.created_at), '') AS candidate
            UNION ALL SELECT MIN(NULLIF(trim(products.created_at), '')) FROM products WHERE products.organization_id = organizations.id
            UNION ALL SELECT MIN(NULLIF(trim(customers.created_at), '')) FROM customers WHERE customers.organization_id = organizations.id
            UNION ALL SELECT MIN(NULLIF(trim(sales_invoices.created_at), '')) FROM sales_invoices WHERE sales_invoices.organization_id = organizations.id
            UNION ALL SELECT MIN(NULLIF(trim(stock_movements.created_at), '')) FROM stock_movements WHERE stock_movements.organization_id = organizations.id
            UNION ALL SELECT MIN(NULLIF(trim(license_state.created_at), '')) FROM license_state WHERE license_state.organization_id = organizations.id
            UNION ALL SELECT MIN(NULLIF(trim(device_activations.activated_at), '')) FROM device_activations WHERE device_activations.organization_id = organizations.id
          ) earliest
          WHERE candidate IS NOT NULL),
         datetime('now')
       )
       WHERE joined_at IS NULL OR trim(joined_at) = ''`,
      "CREATE INDEX IF NOT EXISTS idx_organizations_joined_at ON organizations (joined_at)",
    ],
  },
  {
    version: 12,
    name: "large_dataset_query_indexes",
    sql: [
      "CREATE INDEX IF NOT EXISTS idx_products_org_batch_active ON products (organization_id, batch_no COLLATE NOCASE, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_products_org_hsn_active ON products (organization_id, hsn_code COLLATE NOCASE, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_products_org_warehouse_active ON products (organization_id, warehouse, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_customers_org_phone_active ON customers (organization_id, phone, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_date_active ON sales_invoices (organization_id, deleted_at, invoice_date DESC, invoice_number DESC)",
      `UPDATE sales_invoices
       SET offline_client_id = NULL
       WHERE offline_client_id IS NOT NULL AND trim(offline_client_id) <> ''
         AND rowid NOT IN (
           SELECT MIN(rowid) FROM sales_invoices
           WHERE offline_client_id IS NOT NULL AND trim(offline_client_id) <> ''
           GROUP BY organization_id, offline_client_id
         )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_invoices_org_client_idempotency ON sales_invoices (organization_id, offline_client_id) WHERE offline_client_id IS NOT NULL AND trim(offline_client_id) <> ''",
      "CREATE INDEX IF NOT EXISTS idx_movements_org_batch_created ON stock_movements (organization_id, batch_id, created_at DESC)",
    ],
  },
  {
    version: 13,
    name: "atomic_nonnegative_stock_guard",
    sql: [
      `CREATE TRIGGER IF NOT EXISTS trg_products_nonnegative_stock_update
       BEFORE UPDATE OF stock ON products
       FOR EACH ROW WHEN NEW.stock < 0
       BEGIN
         SELECT RAISE(ABORT, 'insufficient_product_stock');
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_products_nonnegative_stock_insert
       BEFORE INSERT ON products
       FOR EACH ROW WHEN NEW.stock < 0
       BEGIN
         SELECT RAISE(ABORT, 'insufficient_product_stock');
      END`,
    ],
  },
  {
    version: 14,
    name: "bounded_invoice_reversal_indexes",
    sql: [
      `UPDATE organizations
       SET next_invoice_number = MAX(
         COALESCE(next_invoice_number, 1),
         COALESCE((
           SELECT MAX(CASE
             WHEN invoice.invoice_number GLOB
               (CASE WHEN trim(COALESCE(organizations.invoice_prefix, '')) = '' THEN 'INV' ELSE trim(organizations.invoice_prefix) END) || '-[0-9]*'
             THEN CAST(substr(
               invoice.invoice_number,
               length(CASE WHEN trim(COALESCE(organizations.invoice_prefix, '')) = '' THEN 'INV' ELSE trim(organizations.invoice_prefix) END) + 2
             ) AS INTEGER)
             ELSE 0
           END)
           FROM sales_invoices invoice
           WHERE invoice.organization_id = organizations.id AND invoice.deleted_at IS NULL
         ), 0) + 1
       )`,
      "CREATE INDEX IF NOT EXISTS idx_movements_org_reference_active ON stock_movements (organization_id, reference_type, reference_id, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_ledger_org_document_active ON ledger_entries (organization_id, document_id, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_payments_org_document_active ON payments (organization_id, document_id, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_customer_active_date ON sales_invoices (organization_id, customer_id, deleted_at, invoice_date DESC, created_at DESC)",
    ],
  },
  {
    version: 15,
    name: "local_financial_year_management",
    sql: [
      `CREATE TABLE IF NOT EXISTS financial_years (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        start_month INTEGER NOT NULL DEFAULT 4 CHECK (start_month BETWEEN 1 AND 12),
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'ARCHIVED')),
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
        previous_financial_year_id TEXT REFERENCES financial_years(id) ON DELETE SET NULL,
        invoice_numbering_mode TEXT NOT NULL DEFAULT 'CONTINUE' CHECK (invoice_numbering_mode IN ('CONTINUE', 'RESTART')),
        opening_snapshot_json TEXT,
        close_summary_json TEXT,
        close_backup_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT,
        reopened_at TEXT,
        reopen_reason TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1,
        UNIQUE (organization_id, start_date),
        UNIQUE (organization_id, label),
        CHECK (date(start_date) IS NOT NULL AND date(end_date) IS NOT NULL AND date(start_date) <= date(end_date))
      )`,
      `CREATE TABLE IF NOT EXISTS financial_year_opening_balances (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE CASCADE,
        source_financial_year_id TEXT REFERENCES financial_years(id) ON DELETE SET NULL,
        party_type TEXT NOT NULL CHECK (party_type IN ('customer', 'supplier')),
        party_id TEXT NOT NULL,
        balance_type TEXT NOT NULL CHECK (balance_type IN ('RECEIVABLE', 'PAYABLE')),
        amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, financial_year_id, party_type, party_id, balance_type)
      )`,
      `CREATE TABLE IF NOT EXISTS financial_year_inventory_openings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE CASCADE,
        source_financial_year_id TEXT REFERENCES financial_years(id) ON DELETE SET NULL,
        inventory_key TEXT NOT NULL,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
        batch_id TEXT REFERENCES stock_batches(id) ON DELETE SET NULL,
        batch_no TEXT,
        expiry_date TEXT,
        quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        purchase_rate REAL,
        mrp REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, financial_year_id, inventory_key)
      )`,
      `CREATE TABLE IF NOT EXISTS financial_year_invoice_sequences (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE CASCADE,
        prefix TEXT NOT NULL DEFAULT 'INV',
        next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, financial_year_id)
      )`,
      "ALTER TABLE sales_invoices ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE sales_invoices ADD COLUMN display_invoice_number TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE stock_movements ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE expenses ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE payments ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE payment_receipts ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE ledger_entries ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE accounting_vouchers ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE credit_notes ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE debit_notes ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE delivery_challans ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE quotations ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE orders ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE gst_invoice_summary ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      "ALTER TABLE gst_hsn_summary ADD COLUMN financial_year_id TEXT REFERENCES financial_years(id) ON DELETE RESTRICT",
      `WITH dated(organization_id, transaction_date) AS (
         SELECT id, date('now', 'localtime') FROM organizations
         UNION ALL SELECT organization_id, date(COALESCE(invoice_date, date, created_at)) FROM sales_invoices
         UNION ALL SELECT organization_id, date(COALESCE(bill_date, created_at)) FROM purchase_invoices
         UNION ALL SELECT organization_id, date(COALESCE(movement_date, created_at)) FROM stock_movements
         UNION ALL SELECT organization_id, date(COALESCE(expense_date, created_at)) FROM expenses
         UNION ALL SELECT organization_id, date(COALESCE(payment_date, created_at)) FROM payments
         UNION ALL SELECT organization_id, date(COALESCE(received_at, created_at)) FROM payment_receipts
         UNION ALL SELECT organization_id, date(COALESCE(entry_date, created_at)) FROM ledger_entries
         UNION ALL SELECT organization_id, date(COALESCE(voucher_date, created_at)) FROM accounting_vouchers
         UNION ALL SELECT organization_id, date(COALESCE(note_date, created_at)) FROM credit_notes
         UNION ALL SELECT organization_id, date(COALESCE(note_date, created_at)) FROM debit_notes
         UNION ALL SELECT organization_id, date(COALESCE(challan_date, created_at)) FROM delivery_challans
         UNION ALL SELECT organization_id, date(created_at) FROM quotations
         UNION ALL SELECT organization_id, date(created_at) FROM orders
         UNION ALL SELECT organization_id, date(period_key || '-01') FROM gst_hsn_summary
       ), years AS (
         SELECT DISTINCT organization_id,
           CAST(strftime('%Y', transaction_date) AS INTEGER) - CASE WHEN CAST(strftime('%m', transaction_date) AS INTEGER) < 4 THEN 1 ELSE 0 END AS start_year
         FROM dated WHERE organization_id IS NOT NULL AND transaction_date IS NOT NULL
       )
       INSERT OR IGNORE INTO financial_years (
         id, organization_id, label, start_date, end_date, start_month, status, is_active,
         invoice_numbering_mode, created_at, closed_at, schema_version
       )
       SELECT
         'fy:' || organization_id || ':' || start_year || ':4',
         organization_id,
         'FY ' || start_year || '–' || printf('%02d', (start_year + 1) % 100),
         printf('%04d-04-01', start_year),
         printf('%04d-03-31', start_year + 1),
         4,
         CASE WHEN date(printf('%04d-03-31', start_year + 1)) < date('now', 'localtime') THEN 'CLOSED' ELSE 'OPEN' END,
         CASE WHEN date('now', 'localtime') BETWEEN date(printf('%04d-04-01', start_year)) AND date(printf('%04d-03-31', start_year + 1)) THEN 1 ELSE 0 END,
         'CONTINUE',
         datetime('now'),
         CASE WHEN date(printf('%04d-03-31', start_year + 1)) < date('now', 'localtime') THEN datetime('now') ELSE NULL END,
         1
       FROM years`,
      `UPDATE financial_years AS current
       SET previous_financial_year_id = (
         SELECT previous.id FROM financial_years previous
         WHERE previous.organization_id = current.organization_id
           AND date(previous.end_date) < date(current.start_date)
         ORDER BY previous.end_date DESC LIMIT 1
       )
       WHERE previous_financial_year_id IS NULL`,
      `UPDATE sales_invoices
       SET financial_year_id = 'fy:' || organization_id || ':' ||
         (CAST(strftime('%Y', date(COALESCE(invoice_date, date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(invoice_date, date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4',
           display_invoice_number = COALESCE(NULLIF(trim(display_invoice_number), ''), invoice_number)
       WHERE financial_year_id IS NULL OR display_invoice_number IS NULL OR trim(display_invoice_number) = ''`,
      `UPDATE purchase_invoices SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(bill_date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(bill_date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE stock_movements SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(movement_date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(movement_date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE expenses SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(expense_date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(expense_date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE payments SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(payment_date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(payment_date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE payment_receipts SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(received_at, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(received_at, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE ledger_entries SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(entry_date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(entry_date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE accounting_vouchers SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(voucher_date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(voucher_date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE credit_notes SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(note_date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(note_date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE debit_notes SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(note_date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(note_date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE delivery_challans SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(COALESCE(challan_date, created_at))) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(COALESCE(challan_date, created_at))) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE quotations SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(created_at)) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(created_at)) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE orders SET financial_year_id = 'fy:' || organization_id || ':' || (CAST(strftime('%Y', date(created_at)) AS INTEGER) - CASE WHEN CAST(strftime('%m', date(created_at)) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4' WHERE financial_year_id IS NULL`,
      `UPDATE gst_invoice_summary SET financial_year_id = (SELECT invoice.financial_year_id FROM sales_invoices invoice WHERE invoice.id = gst_invoice_summary.invoice_id AND invoice.organization_id = gst_invoice_summary.organization_id) WHERE financial_year_id IS NULL`,
      `UPDATE gst_hsn_summary SET financial_year_id = (
         SELECT fy.id FROM financial_years fy WHERE fy.organization_id = gst_hsn_summary.organization_id
           AND (gst_hsn_summary.period_key || '-01') BETWEEN fy.start_date AND fy.end_date LIMIT 1
       ) WHERE financial_year_id IS NULL`,
      `INSERT OR IGNORE INTO financial_year_invoice_sequences (id, organization_id, financial_year_id, prefix, next_number, updated_at)
       SELECT 'fy-seq:' || fy.id, fy.organization_id, fy.id,
         CASE WHEN trim(COALESCE(org.invoice_prefix, '')) = '' THEN 'INV' ELSE trim(org.invoice_prefix) END,
         MAX(1, COALESCE(org.next_invoice_number, 1)), datetime('now')
       FROM financial_years fy JOIN organizations org ON org.id = fy.organization_id`,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_years_one_active ON financial_years (organization_id) WHERE is_active = 1",
      "CREATE INDEX IF NOT EXISTS idx_financial_years_org_dates ON financial_years (organization_id, start_date DESC, end_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_financial_year_opening_party ON financial_year_opening_balances (organization_id, financial_year_id, party_type, party_id)",
      "CREATE INDEX IF NOT EXISTS idx_financial_year_opening_inventory ON financial_year_inventory_openings (organization_id, financial_year_id, product_id, warehouse_id, batch_id)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_fy_date ON sales_invoices (organization_id, financial_year_id, invoice_date DESC, id DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_fy_customer ON sales_invoices (organization_id, financial_year_id, customer_id, invoice_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_fy_status ON sales_invoices (organization_id, financial_year_id, payment_status, invoice_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_fy_number ON sales_invoices (organization_id, financial_year_id, invoice_number COLLATE NOCASE, display_invoice_number COLLATE NOCASE)",
      "CREATE INDEX IF NOT EXISTS idx_purchase_invoices_org_fy_date ON purchase_invoices (organization_id, financial_year_id, bill_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_stock_movements_org_fy_date ON stock_movements (organization_id, financial_year_id, movement_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_payments_org_fy_party_date ON payments (organization_id, financial_year_id, party_type, party_id, payment_date DESC)",
      "CREATE INDEX IF NOT EXISTS idx_ledger_org_fy_account_date ON ledger_entries (organization_id, financial_year_id, account_type, account_id, entry_date DESC)",
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_invoice_insert
       BEFORE INSERT ON sales_invoices FOR EACH ROW
       WHEN NEW.financial_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = NEW.financial_year_id AND fy.organization_id = NEW.organization_id AND fy.status <> 'OPEN')
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_invoice_update
       BEFORE UPDATE ON sales_invoices FOR EACH ROW
       WHEN OLD.financial_year_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = OLD.financial_year_id AND fy.organization_id = OLD.organization_id AND fy.status <> 'OPEN')
         AND (OLD.invoice_date IS NOT NEW.invoice_date OR OLD.customer_id IS NOT NEW.customer_id OR OLD.invoice_number IS NOT NEW.invoice_number
           OR OLD.subtotal IS NOT NEW.subtotal OR OLD.tax_total IS NOT NEW.tax_total OR OLD.grand_total IS NOT NEW.grand_total OR OLD.deleted_at IS NOT NEW.deleted_at)
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_invoice_delete
       BEFORE DELETE ON sales_invoices FOR EACH ROW
       WHEN OLD.financial_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = OLD.financial_year_id AND fy.status <> 'OPEN')
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_item_mutation
       BEFORE UPDATE ON sales_invoice_items FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM sales_invoices invoice JOIN financial_years fy ON fy.id = invoice.financial_year_id WHERE invoice.id = OLD.invoice_id AND invoice.organization_id = OLD.organization_id AND fy.status <> 'OPEN')
         AND (OLD.product_id IS NOT NEW.product_id OR OLD.quantity IS NOT NEW.quantity OR OLD.unit_price IS NOT NEW.unit_price OR OLD.tax_percent IS NOT NEW.tax_percent OR OLD.line_total IS NOT NEW.line_total OR OLD.deleted_at IS NOT NEW.deleted_at)
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_movement_insert
       BEFORE INSERT ON stock_movements FOR EACH ROW
       WHEN NEW.financial_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = NEW.financial_year_id AND fy.status <> 'OPEN')
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_movement_update
       BEFORE UPDATE ON stock_movements FOR EACH ROW
       WHEN OLD.financial_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = OLD.financial_year_id AND fy.status <> 'OPEN')
         AND (OLD.quantity IS NOT NEW.quantity OR OLD.movement_date IS NOT NEW.movement_date OR OLD.product_id IS NOT NEW.product_id OR OLD.batch_id IS NOT NEW.batch_id OR OLD.warehouse_id IS NOT NEW.warehouse_id OR OLD.deleted_at IS NOT NEW.deleted_at)
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_movement_delete
       BEFORE DELETE ON stock_movements FOR EACH ROW
       WHEN OLD.financial_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = OLD.financial_year_id AND fy.status <> 'OPEN')
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_purchase_insert
       BEFORE INSERT ON purchase_invoices FOR EACH ROW
       WHEN NEW.financial_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = NEW.financial_year_id AND fy.status <> 'OPEN')
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_ledger_insert
       BEFORE INSERT ON ledger_entries FOR EACH ROW
       WHEN NEW.financial_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = NEW.financial_year_id AND fy.status <> 'OPEN')
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_no_closed_payment_insert
       BEFORE INSERT ON payments FOR EACH ROW
       WHEN NEW.financial_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = NEW.financial_year_id AND fy.status <> 'OPEN')
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      ...closedFinancialYearMutationTriggers("purchase_invoices", "purchase_invoice"),
      ...closedFinancialYearMutationTriggers("expenses", "expense"),
      ...closedFinancialYearMutationTriggers("payments", "payment"),
      ...closedFinancialYearMutationTriggers("payment_receipts", "payment_receipt"),
      ...closedFinancialYearMutationTriggers("ledger_entries", "ledger_entry"),
      ...closedFinancialYearMutationTriggers("accounting_vouchers", "accounting_voucher"),
      ...closedFinancialYearMutationTriggers("credit_notes", "credit_note"),
      ...closedFinancialYearMutationTriggers("debit_notes", "debit_note"),
      ...closedFinancialYearMutationTriggers("delivery_challans", "delivery_challan"),
      ...closedFinancialYearMutationTriggers("quotations", "quotation"),
      ...closedFinancialYearMutationTriggers("orders", "order"),
      ...closedFinancialYearMutationTriggers("gst_invoice_summary", "gst_invoice_summary"),
      ...closedFinancialYearMutationTriggers("gst_hsn_summary", "gst_hsn_summary"),
      ...closedFinancialYearMutationTriggers("financial_year_opening_balances", "opening_balance"),
      ...closedFinancialYearMutationTriggers("financial_year_inventory_openings", "inventory_opening"),
      ...closedFinancialYearChildTriggers("sales_invoice_items", "sales_invoices", "invoice_id", "sales_invoice_item"),
      ...closedFinancialYearChildTriggers("purchase_invoice_items", "purchase_invoices", "purchase_invoice_id", "purchase_invoice_item"),
      ...closedFinancialYearChildTriggers("accounting_voucher_entries", "accounting_vouchers", "voucher_id", "accounting_voucher_entry"),
      ...closedFinancialYearChildTriggers("credit_note_items", "credit_notes", "credit_note_id", "credit_note_item"),
      ...closedFinancialYearChildTriggers("debit_note_items", "debit_notes", "debit_note_id", "debit_note_item"),
      ...closedFinancialYearChildTriggers("delivery_challan_items", "delivery_challans", "challan_id", "delivery_challan_item"),
      ...closedFinancialYearChildTriggers("quotation_items", "quotations", "quotation_id", "quotation_item"),
      ...closedFinancialYearChildTriggers("order_items", "orders", "order_id", "order_item"),
      ...financialYearDateAssignmentTriggers("sales_invoices", "sales_invoice", "COALESCE(ROW.invoice_date, ROW.date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("purchase_invoices", "purchase_invoice", "COALESCE(ROW.bill_date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("stock_movements", "stock_movement", "COALESCE(ROW.movement_date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("expenses", "expense", "COALESCE(ROW.expense_date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("payments", "payment", "COALESCE(ROW.payment_date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("payment_receipts", "payment_receipt", "COALESCE(ROW.received_at, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("ledger_entries", "ledger_entry", "COALESCE(ROW.entry_date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("accounting_vouchers", "accounting_voucher", "COALESCE(ROW.voucher_date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("credit_notes", "credit_note", "COALESCE(ROW.note_date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("debit_notes", "debit_note", "COALESCE(ROW.note_date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("delivery_challans", "delivery_challan", "COALESCE(ROW.challan_date, ROW.created_at)"),
      ...financialYearDateAssignmentTriggers("quotations", "quotation", "ROW.created_at"),
      ...financialYearDateAssignmentTriggers("orders", "order", "ROW.created_at"),
      `CREATE TRIGGER IF NOT EXISTS trg_financial_year_verify_inventory_opening
       BEFORE UPDATE OF opening_snapshot_json ON financial_years FOR EACH ROW
       WHEN NEW.opening_snapshot_json IS NOT NULL AND NEW.previous_financial_year_id IS NOT NULL
         AND ABS(
           COALESCE((SELECT SUM(quantity) FROM financial_year_inventory_openings opening WHERE opening.organization_id = NEW.organization_id AND opening.financial_year_id = NEW.id), 0)
           - COALESCE((SELECT SUM(stock) FROM products product WHERE product.organization_id = NEW.organization_id AND product.deleted_at IS NULL), 0)
         ) > 0.0001
      BEGIN SELECT RAISE(ABORT, 'financial_year_inventory_opening_mismatch'); END`,
    ],
  },
  {
    version: 16,
    name: "financial_year_operational_integrity_repair",
    sql: [
      `CREATE TEMP TABLE IF NOT EXISTS fy_v16_repair_targets (
         organization_id TEXT PRIMARY KEY,
         expected_financial_year_id TEXT NOT NULL,
         prior_active_financial_year_id TEXT
       )`,
      "DELETE FROM fy_v16_repair_targets",
      `INSERT INTO fy_v16_repair_targets (organization_id, expected_financial_year_id, prior_active_financial_year_id)
       SELECT organization.id,
         'fy:' || organization.id || ':' ||
           (CAST(strftime('%Y', date('now', 'localtime')) AS INTEGER) - CASE WHEN CAST(strftime('%m', date('now', 'localtime')) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4',
         (SELECT active.id FROM financial_years active WHERE active.organization_id = organization.id AND active.is_active = 1 LIMIT 1)
       FROM organizations organization
       WHERE EXISTS (
         SELECT 1 FROM financial_years active
         WHERE active.organization_id = organization.id AND active.is_active = 1
           AND date('now', 'localtime') NOT BETWEEN date(active.start_date) AND date(active.end_date)
       ) OR EXISTS (
         SELECT 1 FROM financial_years expected
         WHERE expected.organization_id = organization.id
           AND expected.id = 'fy:' || organization.id || ':' ||
             (CAST(strftime('%Y', date('now', 'localtime')) AS INTEGER) - CASE WHEN CAST(strftime('%m', date('now', 'localtime')) AS INTEGER) < 4 THEN 1 ELSE 0 END) || ':4'
           AND expected.status = 'OPEN' AND expected.is_active = 0
           AND NOT EXISTS (SELECT 1 FROM financial_years active WHERE active.organization_id = organization.id AND active.is_active = 1)
       )`,
      `UPDATE sales_invoices AS transaction_row
       SET financial_year_id = (
         SELECT correct.id FROM financial_years correct
         WHERE correct.organization_id = transaction_row.organization_id
           AND date(COALESCE(transaction_row.invoice_date, transaction_row.date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date)
         LIMIT 1
       )
       WHERE transaction_row.organization_id IN (SELECT organization_id FROM fy_v16_repair_targets)
         AND EXISTS (SELECT 1 FROM financial_years bad WHERE bad.id = transaction_row.financial_year_id AND bad.organization_id = transaction_row.organization_id AND date(bad.start_date) > date('now', 'localtime'))
         AND EXISTS (SELECT 1 FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.invoice_date, transaction_row.date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) AND correct.id <> transaction_row.financial_year_id)`,
      `UPDATE purchase_invoices AS transaction_row
       SET financial_year_id = (SELECT correct.id FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.bill_date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) LIMIT 1)
       WHERE transaction_row.organization_id IN (SELECT organization_id FROM fy_v16_repair_targets)
         AND EXISTS (SELECT 1 FROM financial_years bad WHERE bad.id = transaction_row.financial_year_id AND bad.organization_id = transaction_row.organization_id AND date(bad.start_date) > date('now', 'localtime'))
         AND EXISTS (SELECT 1 FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.bill_date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) AND correct.id <> transaction_row.financial_year_id)`,
      `UPDATE stock_movements AS transaction_row
       SET financial_year_id = (SELECT correct.id FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.movement_date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) LIMIT 1)
       WHERE transaction_row.organization_id IN (SELECT organization_id FROM fy_v16_repair_targets)
         AND EXISTS (SELECT 1 FROM financial_years bad WHERE bad.id = transaction_row.financial_year_id AND bad.organization_id = transaction_row.organization_id AND date(bad.start_date) > date('now', 'localtime'))
         AND EXISTS (SELECT 1 FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.movement_date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) AND correct.id <> transaction_row.financial_year_id)`,
      `UPDATE payments AS transaction_row
       SET financial_year_id = (SELECT correct.id FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.payment_date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) LIMIT 1)
       WHERE transaction_row.organization_id IN (SELECT organization_id FROM fy_v16_repair_targets)
         AND EXISTS (SELECT 1 FROM financial_years bad WHERE bad.id = transaction_row.financial_year_id AND bad.organization_id = transaction_row.organization_id AND date(bad.start_date) > date('now', 'localtime'))
         AND EXISTS (SELECT 1 FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.payment_date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) AND correct.id <> transaction_row.financial_year_id)`,
      `UPDATE payment_receipts AS transaction_row
       SET financial_year_id = (SELECT correct.id FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.received_at, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) LIMIT 1)
       WHERE transaction_row.organization_id IN (SELECT organization_id FROM fy_v16_repair_targets)
         AND EXISTS (SELECT 1 FROM financial_years bad WHERE bad.id = transaction_row.financial_year_id AND bad.organization_id = transaction_row.organization_id AND date(bad.start_date) > date('now', 'localtime'))
         AND EXISTS (SELECT 1 FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.received_at, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) AND correct.id <> transaction_row.financial_year_id)`,
      `UPDATE ledger_entries AS transaction_row
       SET financial_year_id = (SELECT correct.id FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.entry_date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) LIMIT 1)
       WHERE transaction_row.organization_id IN (SELECT organization_id FROM fy_v16_repair_targets)
         AND EXISTS (SELECT 1 FROM financial_years bad WHERE bad.id = transaction_row.financial_year_id AND bad.organization_id = transaction_row.organization_id AND date(bad.start_date) > date('now', 'localtime'))
         AND EXISTS (SELECT 1 FROM financial_years correct WHERE correct.organization_id = transaction_row.organization_id AND date(COALESCE(transaction_row.entry_date, transaction_row.created_at)) BETWEEN date(correct.start_date) AND date(correct.end_date) AND correct.id <> transaction_row.financial_year_id)`,
      `CREATE TEMP TABLE IF NOT EXISTS fy_v16_premature_years (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, label TEXT NOT NULL)`,
      "DELETE FROM fy_v16_premature_years",
      `INSERT INTO fy_v16_premature_years (id, organization_id, label)
       SELECT future.id, future.organization_id, future.label FROM financial_years future
       WHERE date(future.start_date) > date('now', 'localtime')
         AND NOT EXISTS (SELECT 1 FROM sales_invoices row WHERE row.organization_id = future.organization_id AND row.financial_year_id = future.id)
         AND NOT EXISTS (SELECT 1 FROM purchase_invoices row WHERE row.organization_id = future.organization_id AND row.financial_year_id = future.id)
         AND NOT EXISTS (SELECT 1 FROM stock_movements row WHERE row.organization_id = future.organization_id AND row.financial_year_id = future.id)
         AND NOT EXISTS (SELECT 1 FROM payments row WHERE row.organization_id = future.organization_id AND row.financial_year_id = future.id)
         AND NOT EXISTS (SELECT 1 FROM ledger_entries row WHERE row.organization_id = future.organization_id AND row.financial_year_id = future.id)`,
      `INSERT OR IGNORE INTO local_audit_logs (id, organization_id, action, entity_type, entity_id, description, created_at, updated_at, sync_status)
       SELECT 'fy-v16-premature:' || premature.id, premature.organization_id, 'financial_year.premature_record_archived', 'financial_year', premature.id,
         premature.label || ' was created before its start date and had no dated transactions. It was preserved as archived; derived opening snapshots were retained for audit.',
         datetime('now'), datetime('now'), 'local'
       FROM fy_v16_premature_years premature`,
      `UPDATE financial_years SET status = 'ARCHIVED', is_active = 0
       WHERE id IN (SELECT id FROM fy_v16_premature_years)`,
      `UPDATE financial_years SET is_active = 0
       WHERE organization_id IN (SELECT organization_id FROM fy_v16_repair_targets) AND is_active = 1`,
      `UPDATE financial_years SET is_active = 1, status = 'OPEN', schema_version = MAX(schema_version, 2)
       WHERE id IN (SELECT expected_financial_year_id FROM fy_v16_repair_targets) AND status = 'OPEN'`,
      `INSERT OR IGNORE INTO local_audit_logs (id, organization_id, action, entity_type, entity_id, description, created_at, updated_at, sync_status)
       SELECT 'fy-v16-pointer:' || target.organization_id, target.organization_id, 'financial_year.legacy_state_repaired', 'financial_year', target.expected_financial_year_id,
         'Operational financial year repaired for local business date ' || date('now', 'localtime') || '. The date-valid current year was restored as active; future records and transactions were preserved and only date-provable assignments were corrected.',
         datetime('now'), datetime('now'), 'local'
       FROM fy_v16_repair_targets target`,
      // A closed invoice remains immutable except for settlement state. This
      // permits collections after year-end while the payment and ledger rows
      // are posted to the current operational year.
      "DROP TRIGGER IF EXISTS trg_fy_guard_sales_invoice_update",
      `CREATE TRIGGER IF NOT EXISTS trg_fy_guard_sales_invoice_update
       BEFORE UPDATE ON sales_invoices FOR EACH ROW
       WHEN OLD.financial_year_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = OLD.financial_year_id AND fy.organization_id = OLD.organization_id AND fy.status <> 'OPEN')
         AND (
           OLD.financial_year_id IS NOT NEW.financial_year_id OR OLD.invoice_date IS NOT NEW.invoice_date OR OLD.date IS NOT NEW.date
           OR OLD.customer_id IS NOT NEW.customer_id OR OLD.customer_name IS NOT NEW.customer_name
           OR OLD.invoice_number IS NOT NEW.invoice_number OR OLD.display_invoice_number IS NOT NEW.display_invoice_number
           OR OLD.invoice_type IS NOT NEW.invoice_type OR OLD.due_date IS NOT NEW.due_date
           OR OLD.subtotal IS NOT NEW.subtotal OR OLD.discount_amount IS NOT NEW.discount_amount OR OLD.discount_total IS NOT NEW.discount_total
           OR OLD.taxable_amount IS NOT NEW.taxable_amount OR OLD.tax_amount IS NOT NEW.tax_amount OR OLD.tax_total IS NOT NEW.tax_total
           OR OLD.total_amount IS NOT NEW.total_amount OR OLD.grand_total IS NOT NEW.grand_total OR OLD.total IS NOT NEW.total
           OR OLD.payment_method IS NOT NEW.payment_method OR OLD.notes IS NOT NEW.notes
           OR OLD.shipping_code IS NOT NEW.shipping_code OR OLD.courier_name IS NOT NEW.courier_name OR OLD.tracking_number IS NOT NEW.tracking_number
           OR OLD.deleted_at IS NOT NEW.deleted_at
         )
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      "CREATE INDEX IF NOT EXISTS idx_stock_batches_org_product_batch_available ON stock_batches (organization_id, product_id, batch_no COLLATE NOCASE, warehouse_id, deleted_at, purchase_date, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_inventory_items_org_product_batch_warehouse ON inventory_items (organization_id, product_id, batch_id, warehouse_id, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_payments_org_document_date ON payments (organization_id, document_type, document_id, payment_date DESC, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_receipts_org_invoice_date ON payment_receipts (organization_id, invoice_id, received_at DESC, deleted_at)",
      "DROP TABLE fy_v16_premature_years",
      "DROP TABLE fy_v16_repair_targets",
    ],
  },
  {
    version: 17,
    name: "invoice_settlement_status_integrity_repair",
    sql: [
      // Older builds could leave the text payment label out of sync with the
      // authoritative paid/outstanding amounts. Repair only rows whose money
      // arithmetic is already internally consistent; never infer or rewrite a
      // payment amount during this migration.
      `CREATE TEMP TABLE IF NOT EXISTS fy_v17_settlement_repairs (
         organization_id TEXT PRIMARY KEY,
         sales_invoice_count INTEGER NOT NULL DEFAULT 0,
         purchase_invoice_count INTEGER NOT NULL DEFAULT 0
       )`,
      "DELETE FROM fy_v17_settlement_repairs",
      `INSERT INTO fy_v17_settlement_repairs (organization_id, sales_invoice_count, purchase_invoice_count)
       SELECT organization.id,
         (SELECT COUNT(*) FROM sales_invoices invoice
          WHERE invoice.organization_id = organization.id AND invoice.deleted_at IS NULL
            AND COALESCE(invoice.grand_total, invoice.total_amount, invoice.total, 0) >= 0
            AND COALESCE(invoice.paid_amount, 0) >= 0
            AND COALESCE(invoice.paid_amount, 0) <= COALESCE(invoice.grand_total, invoice.total_amount, invoice.total, 0) + 0.01
            AND ABS(COALESCE(invoice.outstanding_amount, 0) - MAX(0, COALESCE(invoice.grand_total, invoice.total_amount, invoice.total, 0) - COALESCE(invoice.paid_amount, 0))) <= 0.01
            AND lower(COALESCE(invoice.payment_status, '')) IN ('paid', 'partial', 'unpaid', 'pending', 'overdue', '')
            AND lower(COALESCE(invoice.status, '')) IN ('paid', 'partial', 'unpaid', 'pending', 'overdue', '')
            AND (
              lower(COALESCE(invoice.payment_status, '')) <> CASE
                WHEN COALESCE(invoice.grand_total, invoice.total_amount, invoice.total, 0) <= 0.01 OR COALESCE(invoice.paid_amount, 0) >= COALESCE(invoice.grand_total, invoice.total_amount, invoice.total, 0) - 0.01 THEN 'paid'
                WHEN COALESCE(invoice.paid_amount, 0) > 0.01 THEN 'partial' ELSE 'unpaid' END
              OR lower(COALESCE(invoice.status, '')) <> CASE
                WHEN COALESCE(invoice.grand_total, invoice.total_amount, invoice.total, 0) <= 0.01 OR COALESCE(invoice.paid_amount, 0) >= COALESCE(invoice.grand_total, invoice.total_amount, invoice.total, 0) - 0.01 THEN 'paid'
                WHEN COALESCE(invoice.paid_amount, 0) > 0.01 THEN 'partial' ELSE 'unpaid' END
            )),
         (SELECT COUNT(*) FROM purchase_invoices purchase
          WHERE purchase.organization_id = organization.id AND purchase.deleted_at IS NULL
            AND COALESCE(purchase.grand_total, 0) >= 0
            AND COALESCE(purchase.paid_amount, 0) >= 0
            AND COALESCE(purchase.paid_amount, 0) <= COALESCE(purchase.grand_total, 0) + 0.01
            AND ABS(COALESCE(purchase.outstanding_amount, 0) - MAX(0, COALESCE(purchase.grand_total, 0) - COALESCE(purchase.paid_amount, 0))) <= 0.01
            AND lower(COALESCE(purchase.status, '')) IN ('paid', 'partial', 'unpaid', 'pending', 'overdue', '')
            AND lower(COALESCE(purchase.status, '')) <> CASE
              WHEN COALESCE(purchase.grand_total, 0) <= 0.01 OR COALESCE(purchase.paid_amount, 0) >= COALESCE(purchase.grand_total, 0) - 0.01 THEN 'paid'
              WHEN COALESCE(purchase.paid_amount, 0) > 0.01 THEN 'partial' ELSE 'unpaid' END)
       FROM organizations organization`,
      `UPDATE sales_invoices
       SET payment_status = CASE
             WHEN COALESCE(grand_total, total_amount, total, 0) <= 0.01 OR COALESCE(paid_amount, 0) >= COALESCE(grand_total, total_amount, total, 0) - 0.01 THEN 'paid'
             WHEN COALESCE(paid_amount, 0) > 0.01 THEN 'partial' ELSE 'unpaid' END,
           status = CASE
             WHEN COALESCE(grand_total, total_amount, total, 0) <= 0.01 OR COALESCE(paid_amount, 0) >= COALESCE(grand_total, total_amount, total, 0) - 0.01 THEN 'paid'
             WHEN COALESCE(paid_amount, 0) > 0.01 THEN 'partial' ELSE 'unpaid' END,
           updated_at = datetime('now')
       WHERE deleted_at IS NULL
         AND COALESCE(grand_total, total_amount, total, 0) >= 0
         AND COALESCE(paid_amount, 0) >= 0
         AND COALESCE(paid_amount, 0) <= COALESCE(grand_total, total_amount, total, 0) + 0.01
         AND ABS(COALESCE(outstanding_amount, 0) - MAX(0, COALESCE(grand_total, total_amount, total, 0) - COALESCE(paid_amount, 0))) <= 0.01
         AND lower(COALESCE(payment_status, '')) IN ('paid', 'partial', 'unpaid', 'pending', 'overdue', '')
         AND lower(COALESCE(status, '')) IN ('paid', 'partial', 'unpaid', 'pending', 'overdue', '')`,
      // A closed supplier bill follows the same settlement rule as a closed
      // sales invoice: the historical document remains immutable while a
      // current-year payment may update only its settlement fields.
      "DROP TRIGGER IF EXISTS trg_fy_guard_purchase_invoice_update",
      `CREATE TRIGGER IF NOT EXISTS trg_fy_guard_purchase_invoice_update
       BEFORE UPDATE ON purchase_invoices FOR EACH ROW
       WHEN OLD.financial_year_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM financial_years fy WHERE fy.id = OLD.financial_year_id AND fy.organization_id = OLD.organization_id AND fy.status <> 'OPEN')
         AND (
           OLD.financial_year_id IS NOT NEW.financial_year_id OR OLD.bill_date IS NOT NEW.bill_date
           OR OLD.supplier_id IS NOT NEW.supplier_id OR OLD.supplier_name IS NOT NEW.supplier_name
           OR OLD.invoice_kind IS NOT NEW.invoice_kind OR OLD.purchase_order_id IS NOT NEW.purchase_order_id
           OR OLD.return_against_id IS NOT NEW.return_against_id OR OLD.goods_received_id IS NOT NEW.goods_received_id
           OR OLD.bill_number IS NOT NEW.bill_number OR OLD.due_date IS NOT NEW.due_date
           OR OLD.subtotal IS NOT NEW.subtotal OR OLD.discount_total IS NOT NEW.discount_total
           OR OLD.taxable_amount IS NOT NEW.taxable_amount OR OLD.tax_total IS NOT NEW.tax_total
           OR OLD.grand_total IS NOT NEW.grand_total OR OLD.received_status IS NOT NEW.received_status
           OR OLD.notes IS NOT NEW.notes OR OLD.deleted_at IS NOT NEW.deleted_at
         )
       BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END`,
      `UPDATE purchase_invoices
       SET status = CASE
             WHEN COALESCE(grand_total, 0) <= 0.01 OR COALESCE(paid_amount, 0) >= COALESCE(grand_total, 0) - 0.01 THEN 'paid'
             WHEN COALESCE(paid_amount, 0) > 0.01 THEN 'partial' ELSE 'unpaid' END,
           updated_at = datetime('now')
       WHERE deleted_at IS NULL
         AND COALESCE(grand_total, 0) >= 0
         AND COALESCE(paid_amount, 0) >= 0
         AND COALESCE(paid_amount, 0) <= COALESCE(grand_total, 0) + 0.01
         AND ABS(COALESCE(outstanding_amount, 0) - MAX(0, COALESCE(grand_total, 0) - COALESCE(paid_amount, 0))) <= 0.01
         AND lower(COALESCE(status, '')) IN ('paid', 'partial', 'unpaid', 'pending', 'overdue', '')`,
      `INSERT OR IGNORE INTO local_audit_logs (id, organization_id, action, entity_type, entity_id, description, created_at, updated_at, sync_status)
       SELECT 'settlement-v17:' || repair.organization_id, repair.organization_id,
         'invoice.settlement_status_repaired', 'organization', repair.organization_id,
         'Reconciled ' || repair.sales_invoice_count || ' sales invoice and ' || repair.purchase_invoice_count || ' purchase invoice payment labels from internally consistent paid and outstanding amounts. Monetary values and payment records were not changed.',
         datetime('now'), datetime('now'), 'local'
       FROM fy_v17_settlement_repairs repair
       WHERE repair.sales_invoice_count > 0 OR repair.purchase_invoice_count > 0`,
      "DROP TABLE fy_v17_settlement_repairs",
    ],
  },
  {
    version: 18,
    name: "phase_one_double_entry_accounting_foundation",
    sql: [
      `CREATE TABLE IF NOT EXISTS accounting_settings (
        organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        accounting_version INTEGER NOT NULL DEFAULT 1,
        activation_date TEXT NOT NULL,
        opening_date TEXT NOT NULL,
        historical_policy TEXT NOT NULL DEFAULT 'CONTROLLED_OPENING',
        initialization_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (initialization_status IN ('PENDING', 'INITIALIZED', 'NEEDS_REVIEW')),
        opening_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE SET NULL,
        warning_count INTEGER NOT NULL DEFAULT 0,
        initialized_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS accounting_sequences (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE CASCADE,
        voucher_type TEXT NOT NULL,
        prefix TEXT NOT NULL,
        next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number > 0),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, financial_year_id, voucher_type)
      )`,
      `CREATE TABLE IF NOT EXISTS accounting_warnings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT REFERENCES financial_years(id) ON DELETE SET NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        warning_code TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        UNIQUE (organization_id, source_type, source_id, warning_code)
      )`,
      "ALTER TABLE chart_of_accounts ADD COLUMN system_role TEXT",
      "ALTER TABLE chart_of_accounts ADD COLUMN tax_role TEXT",
      "ALTER TABLE chart_of_accounts ADD COLUMN customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL",
      "ALTER TABLE chart_of_accounts ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL",
      "ALTER TABLE accounting_vouchers ADD COLUMN source_type TEXT",
      "ALTER TABLE accounting_vouchers ADD COLUMN source_id TEXT",
      "ALTER TABLE accounting_vouchers ADD COLUMN reversal_of_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE RESTRICT",
      "ALTER TABLE accounting_vouchers ADD COLUMN reversed_by_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE RESTRICT",
      "ALTER TABLE accounting_vouchers ADD COLUMN total_debit_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE accounting_vouchers ADD COLUMN total_credit_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE accounting_vouchers ADD COLUMN is_system_generated INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE accounting_vouchers ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE accounting_vouchers ADD COLUMN finalized_at TEXT",
      "ALTER TABLE accounting_vouchers ADD COLUMN created_by TEXT",
      "ALTER TABLE accounting_voucher_entries ADD COLUMN debit_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE accounting_voucher_entries ADD COLUMN credit_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE accounting_voucher_entries ADD COLUMN customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL",
      "ALTER TABLE accounting_voucher_entries ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL",
      "ALTER TABLE accounting_voucher_entries ADD COLUMN reference TEXT",
      "ALTER TABLE sales_invoice_items ADD COLUMN cost_rate_minor INTEGER",
      "ALTER TABLE sales_invoice_items ADD COLUMN cost_amount_minor INTEGER",
      "ALTER TABLE sales_invoice_items ADD COLUMN cost_status TEXT",
      "ALTER TABLE stock_movements ADD COLUMN unit_cost_minor INTEGER",
      "ALTER TABLE stock_movements ADD COLUMN total_cost_minor INTEGER",
      "ALTER TABLE stock_movements ADD COLUMN cost_status TEXT",
      "ALTER TABLE payments ADD COLUMN accounting_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE SET NULL",
      "ALTER TABLE payments ADD COLUMN idempotency_key TEXT",
      "ALTER TABLE payments ADD COLUMN reversed_at TEXT",
      "ALTER TABLE payments ADD COLUMN reversal_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE SET NULL",
      "ALTER TABLE payment_receipts ADD COLUMN reversed_at TEXT",
      "ALTER TABLE payment_receipts ADD COLUMN reversal_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE SET NULL",
      "ALTER TABLE expenses ADD COLUMN expense_account_id TEXT REFERENCES chart_of_accounts(id) ON DELETE RESTRICT",
      "ALTER TABLE expenses ADD COLUMN payment_account_id TEXT REFERENCES chart_of_accounts(id) ON DELETE RESTRICT",
      "ALTER TABLE expenses ADD COLUMN accounting_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE SET NULL",
      "ALTER TABLE expenses ADD COLUMN vendor_name TEXT",
      "ALTER TABLE expenses ADD COLUMN amount_minor INTEGER",
      "ALTER TABLE expenses ADD COLUMN cgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE expenses ADD COLUMN sgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE expenses ADD COLUMN igst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE expenses ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE expenses ADD COLUMN reversed_at TEXT",
      "ALTER TABLE expenses ADD COLUMN replaces_expense_id TEXT REFERENCES expenses(id) ON DELETE SET NULL",
      "ALTER TABLE expenses ADD COLUMN replaced_by_expense_id TEXT REFERENCES expenses(id) ON DELETE SET NULL",
      `UPDATE accounting_vouchers
       SET total_debit_minor = CAST(ROUND(COALESCE(total_debit, 0) * 100) AS INTEGER),
           total_credit_minor = CAST(ROUND(COALESCE(total_credit, 0) * 100) AS INTEGER),
           source_type = COALESCE(source_type, 'LEGACY_VOUCHER'),
           source_id = COALESCE(source_id, id),
           finalized_at = CASE WHEN status = 'posted' THEN COALESCE(finalized_at, updated_at, created_at) ELSE finalized_at END`,
      `UPDATE accounting_voucher_entries
       SET debit_minor = CAST(ROUND(COALESCE(debit, 0) * 100) AS INTEGER),
           credit_minor = CAST(ROUND(COALESCE(credit, 0) * 100) AS INTEGER)`,
      `UPDATE expenses SET amount_minor = CAST(ROUND(COALESCE(amount, 0) * 100) AS INTEGER) WHERE amount_minor IS NULL`,
      `UPDATE chart_of_accounts SET
         system_role = CASE account_code
           WHEN '1000' THEN 'CASH' WHEN '1010' THEN 'BANK' WHEN '1100' THEN 'ACCOUNTS_RECEIVABLE'
           WHEN '1200' THEN 'INVENTORY' WHEN '2000' THEN 'ACCOUNTS_PAYABLE' WHEN '2100' THEN 'OUTPUT_CGST'
           WHEN '2200' THEN 'INPUT_CGST' WHEN '3000' THEN 'CAPITAL' WHEN '4000' THEN 'SALES'
           WHEN '6000' THEN 'MISCELLANEOUS_EXPENSES' ELSE system_role END,
         tax_role = CASE account_code WHEN '2100' THEN 'OUTPUT_CGST' WHEN '2200' THEN 'INPUT_CGST' ELSE tax_role END
       WHERE is_system = 1`,
      `UPDATE chart_of_accounts SET account_name = 'Output CGST', account_group = 'TAX_LIABILITY', account_type = 'LIABILITY', normal_balance = 'credit' WHERE is_system = 1 AND account_code = '2100'`,
      `UPDATE chart_of_accounts SET account_name = 'Input CGST', account_group = 'CURRENT_ASSET', account_type = 'ASSET', normal_balance = 'debit' WHERE is_system = 1 AND account_code = '2200'`,
      `INSERT OR IGNORE INTO chart_of_accounts (
         id, organization_id, account_code, account_name, account_type, account_group, normal_balance,
         opening_balance, current_balance, is_system, is_cash_account, is_bank_account, is_active,
         system_role, tax_role, sync_status, created_at, updated_at
       )
       SELECT 'account:' || organization.id || ':' || seed.code, organization.id, seed.code, seed.name,
         seed.type, seed.group_name, seed.normal, 0, 0, 1, seed.is_cash, seed.is_bank, 1,
         seed.system_role, seed.tax_role, 'local', datetime('now'), datetime('now')
       FROM organizations organization
       CROSS JOIN (
         SELECT '1000' code, 'Cash' name, 'ASSET' type, 'CASH' group_name, 'debit' normal, 1 is_cash, 0 is_bank, 'CASH' system_role, NULL tax_role
         UNION ALL SELECT '1010', 'Bank', 'ASSET', 'BANK', 'debit', 0, 1, 'BANK', NULL
         UNION ALL SELECT '1100', 'Accounts Receivable', 'ASSET', 'RECEIVABLE', 'debit', 0, 0, 'ACCOUNTS_RECEIVABLE', NULL
         UNION ALL SELECT '1200', 'Inventory', 'ASSET', 'INVENTORY', 'debit', 0, 0, 'INVENTORY', NULL
         UNION ALL SELECT '2200', 'Input CGST', 'ASSET', 'CURRENT_ASSET', 'debit', 0, 0, 'INPUT_CGST', 'INPUT_CGST'
         UNION ALL SELECT '2210', 'Input SGST', 'ASSET', 'CURRENT_ASSET', 'debit', 0, 0, 'INPUT_SGST', 'INPUT_SGST'
         UNION ALL SELECT '2220', 'Input IGST', 'ASSET', 'CURRENT_ASSET', 'debit', 0, 0, 'INPUT_IGST', 'INPUT_IGST'
         UNION ALL SELECT '1300', 'Other Current Assets', 'ASSET', 'CURRENT_ASSET', 'debit', 0, 0, 'OTHER_CURRENT_ASSETS', NULL
         UNION ALL SELECT '1500', 'Fixed Assets', 'ASSET', 'FIXED_ASSET', 'debit', 0, 0, 'FIXED_ASSETS', NULL
         UNION ALL SELECT '2000', 'Accounts Payable', 'LIABILITY', 'PAYABLE', 'credit', 0, 0, 'ACCOUNTS_PAYABLE', NULL
         UNION ALL SELECT '2100', 'Output CGST', 'LIABILITY', 'TAX_LIABILITY', 'credit', 0, 0, 'OUTPUT_CGST', 'OUTPUT_CGST'
         UNION ALL SELECT '2110', 'Output SGST', 'LIABILITY', 'TAX_LIABILITY', 'credit', 0, 0, 'OUTPUT_SGST', 'OUTPUT_SGST'
         UNION ALL SELECT '2120', 'Output IGST', 'LIABILITY', 'TAX_LIABILITY', 'credit', 0, 0, 'OUTPUT_IGST', 'OUTPUT_IGST'
         UNION ALL SELECT '2190', 'Other Current Liabilities', 'LIABILITY', 'CURRENT_LIABILITY', 'credit', 0, 0, 'OTHER_CURRENT_LIABILITIES', NULL
         UNION ALL SELECT '3000', 'Capital', 'EQUITY', 'CAPITAL', 'credit', 0, 0, 'CAPITAL', NULL
         UNION ALL SELECT '3100', 'Retained Earnings / Opening Equity', 'EQUITY', 'CAPITAL', 'credit', 0, 0, 'OPENING_EQUITY', NULL
         UNION ALL SELECT '3200', 'Drawings', 'EQUITY', 'CAPITAL', 'debit', 0, 0, 'DRAWINGS', NULL
         UNION ALL SELECT '4000', 'Sales', 'INCOME', 'SALES_INCOME', 'credit', 0, 0, 'SALES', NULL
         UNION ALL SELECT '4200', 'Other Income', 'INCOME', 'OTHER_INCOME', 'credit', 0, 0, 'OTHER_INCOME', NULL
         UNION ALL SELECT '5000', 'Cost of Goods Sold', 'EXPENSE', 'COGS', 'debit', 0, 0, 'COGS', NULL
         UNION ALL SELECT '5100', 'Discount Allowed / Sales Discount', 'EXPENSE', 'DIRECT_EXPENSE', 'debit', 0, 0, 'SALES_DISCOUNT', NULL
         UNION ALL SELECT '5200', 'Freight / Delivery Expense', 'EXPENSE', 'DIRECT_EXPENSE', 'debit', 0, 0, 'FREIGHT_EXPENSE', NULL
         UNION ALL SELECT '6000', 'Miscellaneous Expenses', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'MISCELLANEOUS_EXPENSES', NULL
         UNION ALL SELECT '6010', 'Rent', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'RENT_EXPENSE', NULL
         UNION ALL SELECT '6020', 'Electricity', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'ELECTRICITY_EXPENSE', NULL
         UNION ALL SELECT '6030', 'Salary / Wages', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'SALARY_EXPENSE', NULL
         UNION ALL SELECT '6040', 'Fuel', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'FUEL_EXPENSE', NULL
         UNION ALL SELECT '6050', 'Advertising', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'ADVERTISING_EXPENSE', NULL
         UNION ALL SELECT '6060', 'Repairs', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'REPAIRS_EXPENSE', NULL
         UNION ALL SELECT '6070', 'Internet / Communication', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'COMMUNICATION_EXPENSE', NULL
         UNION ALL SELECT '6080', 'Professional Fees', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'PROFESSIONAL_FEES', NULL
         UNION ALL SELECT '6990', 'Round Off / Rounding Adjustment', 'EXPENSE', 'INDIRECT_EXPENSE', 'debit', 0, 0, 'ROUND_OFF', NULL
       ) seed
       WHERE organization.deleted_at IS NULL`,
      `UPDATE chart_of_accounts SET
         account_type = upper(account_type),
         account_group = upper(account_group)
       WHERE account_type IS NOT NULL`,
      `INSERT OR IGNORE INTO accounting_settings (
         organization_id, accounting_version, activation_date, opening_date, historical_policy,
         initialization_status, created_at, updated_at
       )
       SELECT id, 1, date('now', 'localtime'), date('now', 'localtime'), 'CONTROLLED_OPENING',
         'PENDING', datetime('now'), datetime('now')
       FROM organizations WHERE deleted_at IS NULL`,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_chart_accounts_org_system_role ON chart_of_accounts (organization_id, system_role) WHERE system_role IS NOT NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_org_source ON accounting_vouchers (organization_id, source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL AND status <> 'void'",
      "CREATE INDEX IF NOT EXISTS idx_vouchers_org_fy_date_status ON accounting_vouchers (organization_id, financial_year_id, voucher_date, status, id)",
      "CREATE INDEX IF NOT EXISTS idx_vouchers_org_reversal ON accounting_vouchers (organization_id, reversal_of_voucher_id)",
      "CREATE INDEX IF NOT EXISTS idx_voucher_entries_account_minor ON accounting_voucher_entries (organization_id, account_id, voucher_id, debit_minor, credit_minor)",
      "CREATE INDEX IF NOT EXISTS idx_voucher_entries_customer ON accounting_voucher_entries (organization_id, customer_id, voucher_id)",
      "CREATE INDEX IF NOT EXISTS idx_voucher_entries_supplier ON accounting_voucher_entries (organization_id, supplier_id, voucher_id)",
      "CREATE INDEX IF NOT EXISTS idx_accounting_warnings_open ON accounting_warnings (organization_id, status, financial_year_id, created_at DESC)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_org_idempotency ON payments (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL",
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_line_minor_values_insert
       BEFORE INSERT ON accounting_voucher_entries FOR EACH ROW
       WHEN NEW.debit_minor < 0 OR NEW.credit_minor < 0
         OR (NEW.debit_minor > 0 AND NEW.credit_minor > 0)
         OR (NEW.debit_minor = 0 AND NEW.credit_minor = 0)
       BEGIN SELECT RAISE(ABORT, 'journal_line_invalid'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_line_minor_values_update
       BEFORE UPDATE ON accounting_voucher_entries FOR EACH ROW
       WHEN NEW.debit_minor < 0 OR NEW.credit_minor < 0
         OR (NEW.debit_minor > 0 AND NEW.credit_minor > 0)
         OR (NEW.debit_minor = 0 AND NEW.credit_minor = 0)
       BEGIN SELECT RAISE(ABORT, 'journal_line_invalid'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_line_account_scope
       BEFORE INSERT ON accounting_voucher_entries FOR EACH ROW
       WHEN NEW.account_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM chart_of_accounts account
         WHERE account.id = NEW.account_id AND account.organization_id = NEW.organization_id AND account.is_active = 1
       ) OR NOT EXISTS (
         SELECT 1 FROM accounting_vouchers voucher
         WHERE voucher.id = NEW.voucher_id AND voucher.organization_id = NEW.organization_id AND voucher.status = 'draft'
       )
       BEGIN SELECT RAISE(ABORT, 'journal_account_invalid'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_post_balanced
       BEFORE UPDATE OF status ON accounting_vouchers FOR EACH ROW
       WHEN NEW.status = 'posted' AND OLD.status <> 'posted' AND (
         NEW.total_debit_minor <= 0 OR NEW.total_debit_minor <> NEW.total_credit_minor
         OR (SELECT COUNT(*) FROM accounting_voucher_entries line WHERE line.organization_id = NEW.organization_id AND line.voucher_id = NEW.id) < 2
         OR COALESCE((SELECT SUM(line.debit_minor) FROM accounting_voucher_entries line WHERE line.organization_id = NEW.organization_id AND line.voucher_id = NEW.id), 0) <> NEW.total_debit_minor
         OR COALESCE((SELECT SUM(line.credit_minor) FROM accounting_voucher_entries line WHERE line.organization_id = NEW.organization_id AND line.voucher_id = NEW.id), 0) <> NEW.total_credit_minor
       )
       BEGIN SELECT RAISE(ABORT, 'journal_entry_not_balanced'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_post_financial_year
       BEFORE UPDATE OF status ON accounting_vouchers FOR EACH ROW
       WHEN NEW.status = 'posted' AND OLD.status <> 'posted' AND NOT EXISTS (
         SELECT 1 FROM financial_years fy WHERE fy.id = NEW.financial_year_id AND fy.organization_id = NEW.organization_id
           AND fy.status = 'OPEN' AND date(NEW.voucher_date) BETWEEN date(fy.start_date) AND date(fy.end_date)
       )
       BEGIN SELECT RAISE(ABORT, 'selected_financial_year_closed_or_mismatched'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_posted_line_update
       BEFORE UPDATE ON accounting_voucher_entries FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_vouchers voucher WHERE voucher.id = OLD.voucher_id AND voucher.status = 'posted')
       BEGIN SELECT RAISE(ABORT, 'posted_journal_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_posted_line_delete
       BEFORE DELETE ON accounting_voucher_entries FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_vouchers voucher WHERE voucher.id = OLD.voucher_id AND voucher.status = 'posted')
       BEGIN SELECT RAISE(ABORT, 'posted_journal_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_posted_voucher_delete
       BEFORE DELETE ON accounting_vouchers FOR EACH ROW WHEN OLD.status = 'posted'
       BEGIN SELECT RAISE(ABORT, 'posted_journal_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_system_account_delete
       BEFORE DELETE ON chart_of_accounts FOR EACH ROW WHEN OLD.is_system = 1
       BEGIN SELECT RAISE(ABORT, 'system_account_cannot_be_deleted'); END`,
    ],
  },
  {
    version: 19,
    name: "phase_one_posted_header_hardening",
    sql: [
      `UPDATE accounting_vouchers
       SET status = 'legacy', updated_at = COALESCE(updated_at, datetime('now'))
       WHERE status = 'posted' AND source_type = 'LEGACY_VOUCHER'`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_line_minor_integer_insert
       BEFORE INSERT ON accounting_voucher_entries FOR EACH ROW
       WHEN typeof(NEW.debit_minor) <> 'integer' OR typeof(NEW.credit_minor) <> 'integer'
       BEGIN SELECT RAISE(ABORT, 'journal_line_minor_units_must_be_integer'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_line_minor_integer_update
       BEFORE UPDATE ON accounting_voucher_entries FOR EACH ROW
       WHEN typeof(NEW.debit_minor) <> 'integer' OR typeof(NEW.credit_minor) <> 'integer'
       BEGIN SELECT RAISE(ABORT, 'journal_line_minor_units_must_be_integer'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_accounting_posted_header_immutable
       BEFORE UPDATE OF organization_id, voucher_number, voucher_type, voucher_date, reference_no,
         narration, total_debit, total_credit, total_debit_minor, total_credit_minor, status,
         financial_year_id, source_type, source_id, reversal_of_voucher_id, is_system_generated,
         accounting_version, finalized_at, created_by
       ON accounting_vouchers FOR EACH ROW WHEN OLD.status = 'posted'
       BEGIN SELECT RAISE(ABORT, 'posted_journal_is_immutable'); END`,
    ],
  },
  {
    version: 20,
    name: "accounting_phase_two_purchases_banking_and_gst",
    sql: [
      "ALTER TABLE suppliers ADD COLUMN contact_person TEXT",
      "ALTER TABLE suppliers ADD COLUMN billing_address TEXT",
      "ALTER TABLE suppliers ADD COLUMN pin_code TEXT",
      "ALTER TABLE suppliers ADD COLUMN pan TEXT",
      "ALTER TABLE suppliers ADD COLUMN payment_terms TEXT",
      "ALTER TABLE suppliers ADD COLUMN credit_days INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE suppliers ADD COLUMN opening_balance_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE suppliers ADD COLUMN opening_balance_type TEXT NOT NULL DEFAULT 'payable'",
      "ALTER TABLE suppliers ADD COLUMN notes TEXT",

      "ALTER TABLE purchase_invoices ADD COLUMN supplier_invoice_number TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN supplier_invoice_date TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN purchase_date TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN payment_terms TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN reference_no TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL",
      "ALTER TABLE purchase_invoices ADD COLUMN place_of_supply TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN supplier_gstin TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN supplier_registration_type TEXT NOT NULL DEFAULT 'UNREGISTERED'",
      "ALTER TABLE purchase_invoices ADD COLUMN transaction_type TEXT NOT NULL DEFAULT 'B2B'",
      "ALTER TABLE purchase_invoices ADD COLUMN supply_type TEXT NOT NULL DEFAULT 'INTRA_STATE'",
      "ALTER TABLE purchase_invoices ADD COLUMN tax_category TEXT NOT NULL DEFAULT 'TAXABLE'",
      "ALTER TABLE purchase_invoices ADD COLUMN reverse_charge INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN purchase_classification TEXT NOT NULL DEFAULT 'INVENTORY'",
      "ALTER TABLE purchase_invoices ADD COLUMN purchase_account_id TEXT REFERENCES chart_of_accounts(id) ON DELETE RESTRICT",
      "ALTER TABLE purchase_invoices ADD COLUMN payment_account_id TEXT REFERENCES chart_of_accounts(id) ON DELETE RESTRICT",
      "ALTER TABLE purchase_invoices ADD COLUMN gross_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN discount_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN taxable_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN cgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN sgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN igst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN cess_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN other_charges_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN round_off_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN grand_total_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN paid_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN outstanding_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoices ADD COLUMN accounting_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE SET NULL",
      "ALTER TABLE purchase_invoices ADD COLUMN reversal_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE SET NULL",
      "ALTER TABLE purchase_invoices ADD COLUMN document_status TEXT NOT NULL DEFAULT 'DRAFT'",
      "ALTER TABLE purchase_invoices ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE purchase_invoices ADD COLUMN reversed_at TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN cancellation_reason TEXT",
      "ALTER TABLE purchase_invoices ADD COLUMN itc_status TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED'",
      "ALTER TABLE purchase_invoices ADD COLUMN idempotency_key TEXT",

      "ALTER TABLE purchase_invoice_items ADD COLUMN description TEXT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN hsn_code TEXT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN unit TEXT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN purchase_classification TEXT NOT NULL DEFAULT 'INVENTORY'",
      "ALTER TABLE purchase_invoice_items ADD COLUMN purchase_account_id TEXT REFERENCES chart_of_accounts(id) ON DELETE RESTRICT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN unit_cost_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN gross_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN discount_percent_basis_points INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN discount_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN taxable_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN gst_rate_basis_points INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN cgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN sgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN igst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN cess_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN line_total_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE purchase_invoice_items ADD COLUMN return_against_item_id TEXT REFERENCES purchase_invoice_items(id) ON DELETE RESTRICT",
      "ALTER TABLE purchase_invoice_items ADD COLUMN stock_batch_id TEXT REFERENCES stock_batches(id) ON DELETE SET NULL",

      "ALTER TABLE stock_batches ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL",
      "ALTER TABLE stock_batches ADD COLUMN source_type TEXT",
      "ALTER TABLE stock_batches ADD COLUMN source_id TEXT",
      "ALTER TABLE stock_batches ADD COLUMN source_line_id TEXT",
      "ALTER TABLE stock_batches ADD COLUMN purchase_rate_minor INTEGER",
      "ALTER TABLE stock_batches ADD COLUMN original_quantity REAL",

      "ALTER TABLE payments ADD COLUMN amount_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE payments ADD COLUMN payment_account_id TEXT REFERENCES chart_of_accounts(id) ON DELETE RESTRICT",
      "ALTER TABLE payments ADD COLUMN unallocated_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE payments ADD COLUMN payment_mode TEXT",

      "ALTER TABLE bank_accounts ADD COLUMN display_name TEXT",
      "ALTER TABLE bank_accounts ADD COLUMN account_type TEXT",
      "ALTER TABLE bank_accounts ADD COLUMN masked_identifier TEXT",
      "ALTER TABLE bank_accounts ADD COLUMN opening_balance_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE bank_accounts ADD COLUMN opening_date TEXT",
      "ALTER TABLE bank_accounts ADD COLUMN opening_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE SET NULL",

      "ALTER TABLE expenses ADD COLUMN party_gstin TEXT",
      "ALTER TABLE expenses ADD COLUMN supplier_invoice_number TEXT",
      "ALTER TABLE expenses ADD COLUMN hsn_code TEXT",
      "ALTER TABLE expenses ADD COLUMN taxable_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE expenses ADD COLUMN gst_rate_basis_points INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE expenses ADD COLUMN cess_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE expenses ADD COLUMN place_of_supply TEXT",
      "ALTER TABLE expenses ADD COLUMN supply_type TEXT NOT NULL DEFAULT 'INTRA_STATE'",
      "ALTER TABLE expenses ADD COLUMN tax_category TEXT NOT NULL DEFAULT 'TAXABLE'",
      "ALTER TABLE expenses ADD COLUMN reverse_charge INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE expenses ADD COLUMN itc_status TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED'",

      "ALTER TABLE sales_invoices ADD COLUMN taxable_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoices ADD COLUMN cgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoices ADD COLUMN sgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoices ADD COLUMN igst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoices ADD COLUMN cess_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoices ADD COLUMN grand_total_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoices ADD COLUMN paid_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoices ADD COLUMN outstanding_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoices ADD COLUMN place_of_supply TEXT",
      "ALTER TABLE sales_invoices ADD COLUMN customer_gstin TEXT",
      "ALTER TABLE sales_invoices ADD COLUMN supply_type TEXT",
      "ALTER TABLE sales_invoices ADD COLUMN transaction_type TEXT",
      "ALTER TABLE sales_invoices ADD COLUMN tax_category TEXT",
      "ALTER TABLE sales_invoice_items ADD COLUMN taxable_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoice_items ADD COLUMN cgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoice_items ADD COLUMN sgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoice_items ADD COLUMN igst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoice_items ADD COLUMN cess_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sales_invoice_items ADD COLUMN gst_rate_basis_points INTEGER NOT NULL DEFAULT 0",

      "ALTER TABLE credit_notes ADD COLUMN accounting_voucher_id TEXT REFERENCES accounting_vouchers(id) ON DELETE SET NULL",
      "ALTER TABLE credit_notes ADD COLUMN subtotal_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_notes ADD COLUMN cgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_notes ADD COLUMN sgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_notes ADD COLUMN igst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_notes ADD COLUMN grand_total_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_notes ADD COLUMN document_status TEXT NOT NULL DEFAULT 'DRAFT'",
      "ALTER TABLE credit_note_items ADD COLUMN taxable_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_note_items ADD COLUMN cgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_note_items ADD COLUMN sgst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_note_items ADD COLUMN igst_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_note_items ADD COLUMN cost_amount_minor INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_note_items ADD COLUMN stock_batch_id TEXT REFERENCES stock_batches(id) ON DELETE SET NULL",
      "ALTER TABLE credit_note_items ADD COLUMN hsn_code TEXT",
      "ALTER TABLE credit_note_items ADD COLUMN gst_rate_basis_points INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE credit_note_items ADD COLUMN sales_invoice_item_id TEXT REFERENCES sales_invoice_items(id) ON DELETE RESTRICT",

      `CREATE TABLE IF NOT EXISTS payment_allocations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
        payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
        party_type TEXT NOT NULL CHECK (party_type IN ('supplier', 'customer')),
        party_id TEXT NOT NULL,
        document_type TEXT NOT NULL CHECK (document_type IN ('purchase_invoice', 'sales_invoice')),
        document_id TEXT NOT NULL,
        allocation_minor INTEGER NOT NULL CHECK (allocation_minor > 0),
        allocated_at TEXT NOT NULL,
        reversed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, payment_id, document_type, document_id)
      )`,
      `CREATE TABLE IF NOT EXISTS party_advances (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
        party_type TEXT NOT NULL CHECK (party_type IN ('supplier', 'customer')),
        party_id TEXT NOT NULL,
        payment_id TEXT REFERENCES payments(id) ON DELETE RESTRICT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        advance_minor INTEGER NOT NULL CHECK (advance_minor > 0),
        applied_minor INTEGER NOT NULL DEFAULT 0 CHECK (applied_minor >= 0 AND applied_minor <= advance_minor),
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'APPLIED', 'REVERSED')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, source_type, source_id)
      )`,
      `CREATE TABLE IF NOT EXISTS advance_allocations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
        advance_id TEXT NOT NULL REFERENCES party_advances(id) ON DELETE RESTRICT,
        document_type TEXT NOT NULL CHECK (document_type IN ('purchase_invoice', 'sales_invoice')),
        document_id TEXT NOT NULL,
        allocation_minor INTEGER NOT NULL CHECK (allocation_minor > 0),
        accounting_voucher_id TEXT NOT NULL REFERENCES accounting_vouchers(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, advance_id, document_type, document_id)
      )`,
      `CREATE TABLE IF NOT EXISTS bank_reconciliations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
        voucher_entry_id TEXT NOT NULL REFERENCES accounting_voucher_entries(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'UNRECONCILED' CHECK (status IN ('UNRECONCILED', 'CLEARED', 'REVIEW')),
        cleared_date TEXT,
        bank_reference TEXT,
        notes TEXT,
        reconciled_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, bank_account_id, voucher_entry_id)
      )`,
      `CREATE TABLE IF NOT EXISTS accounting_period_locks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        locked_through TEXT NOT NULL,
        reason TEXT,
        locked_by TEXT,
        unlocked_at TEXT,
        unlocked_by TEXT,
        unlock_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS gst_transaction_classifications (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        registration_type TEXT,
        transaction_type TEXT,
        supply_type TEXT,
        tax_category TEXT,
        reverse_charge INTEGER NOT NULL DEFAULT 0,
        itc_status TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
        review_notes TEXT,
        reviewed_at TEXT,
        reviewed_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, source_type, source_id)
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_attachments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        purchase_invoice_id TEXT NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
        local_relative_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,

      `UPDATE suppliers SET opening_balance_minor = CAST(ROUND(COALESCE(opening_balance, 0) * 100) AS INTEGER)
       WHERE opening_balance_minor = 0 AND COALESCE(opening_balance, 0) <> 0`,
      `UPDATE purchase_invoices SET
         supplier_invoice_number = COALESCE(NULLIF(trim(supplier_invoice_number), ''), bill_number),
         supplier_invoice_date = COALESCE(supplier_invoice_date, bill_date),
         purchase_date = COALESCE(purchase_date, bill_date),
         gross_minor = CAST(ROUND(COALESCE(subtotal, 0) * 100) AS INTEGER),
         discount_minor = CAST(ROUND(COALESCE(discount_total, 0) * 100) AS INTEGER),
         taxable_minor = CAST(ROUND(COALESCE(taxable_amount, 0) * 100) AS INTEGER),
         grand_total_minor = CAST(ROUND(COALESCE(grand_total, 0) * 100) AS INTEGER),
         paid_minor = CAST(ROUND(COALESCE(paid_amount, 0) * 100) AS INTEGER),
         outstanding_minor = CAST(ROUND(COALESCE(outstanding_amount, 0) * 100) AS INTEGER)
       WHERE invoice_kind IN ('purchase_invoice', 'purchase_return')`,
      `UPDATE sales_invoices SET
         taxable_minor = CAST(ROUND(COALESCE(taxable_amount, 0) * 100) AS INTEGER),
         grand_total_minor = CAST(ROUND(COALESCE(grand_total, total_amount, total, 0) * 100) AS INTEGER),
         paid_minor = CAST(ROUND(COALESCE(paid_amount, 0) * 100) AS INTEGER),
         outstanding_minor = CAST(ROUND(COALESCE(outstanding_amount, 0) * 100) AS INTEGER)
       WHERE deleted_at IS NULL`,
      // Exact tax fields must be backfilled for historical closed-year lines.
      // The migration is one atomic transaction; restore the closed-year guard
      // immediately after this data-only conversion.
      "DROP TRIGGER IF EXISTS trg_fy_guard_sales_invoice_item_update",
      `UPDATE sales_invoice_items SET
         taxable_minor = CAST(ROUND(MAX(0, COALESCE(line_total, 0) - COALESCE(gst_amount, 0)) * 100) AS INTEGER),
         cgst_minor = CAST(ROUND(COALESCE(cgst_amount, 0) * 100) AS INTEGER),
         sgst_minor = CAST(ROUND(COALESCE(sgst_amount, 0) * 100) AS INTEGER),
         igst_minor = CAST(ROUND(COALESCE(igst_amount, 0) * 100) AS INTEGER),
         gst_rate_basis_points = CAST(ROUND(COALESCE(tax_percent, 0) * 100) AS INTEGER)
       WHERE deleted_at IS NULL`,
      ...closedFinancialYearChildTriggers("sales_invoice_items", "sales_invoices", "invoice_id", "sales_invoice_item"),
      `UPDATE sales_invoices SET
         cgst_minor = COALESCE((SELECT SUM(item.cgst_minor) FROM sales_invoice_items item WHERE item.invoice_id = sales_invoices.id AND item.deleted_at IS NULL), 0),
         sgst_minor = COALESCE((SELECT SUM(item.sgst_minor) FROM sales_invoice_items item WHERE item.invoice_id = sales_invoices.id AND item.deleted_at IS NULL), 0),
         igst_minor = COALESCE((SELECT SUM(item.igst_minor) FROM sales_invoice_items item WHERE item.invoice_id = sales_invoices.id AND item.deleted_at IS NULL), 0)
       WHERE deleted_at IS NULL`,

      `INSERT OR IGNORE INTO chart_of_accounts (
         id, organization_id, account_code, account_name, account_type, account_group, normal_balance,
         opening_balance, current_balance, is_system, is_cash_account, is_bank_account, is_active,
         system_role, tax_role, sync_status, created_at, updated_at
       )
       SELECT 'account:' || organization.id || ':' || seed.code, organization.id, seed.code, seed.name,
         seed.type, seed.group_name, seed.normal, 0, 0, 1, 0, 0, 1, seed.system_role,
         seed.tax_role, 'local', datetime('now'), datetime('now')
       FROM organizations organization CROSS JOIN (
         SELECT '1310' code, 'Advances to Suppliers' name, 'ASSET' type, 'CURRENT_ASSET' group_name, 'debit' normal, 'SUPPLIER_ADVANCES' system_role, NULL tax_role
         UNION ALL SELECT '2010', 'Advances from Customers', 'LIABILITY', 'CURRENT_LIABILITY', 'credit', 'CUSTOMER_ADVANCES', NULL
         UNION ALL SELECT '2130', 'Output Cess', 'LIABILITY', 'TAX_LIABILITY', 'credit', 'OUTPUT_CESS', 'OUTPUT_CESS'
         UNION ALL SELECT '2230', 'Input Cess', 'ASSET', 'CURRENT_ASSET', 'debit', 'INPUT_CESS', 'INPUT_CESS'
         UNION ALL SELECT '5300', 'Purchases / Direct Expense', 'EXPENSE', 'DIRECT_EXPENSE', 'debit', 'PURCHASES', NULL
       ) seed WHERE organization.deleted_at IS NULL`,
      "UPDATE accounting_settings SET accounting_version = MAX(accounting_version, 2), updated_at = datetime('now')",

      "CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_supplier_invoice_fy ON purchase_invoices (organization_id, supplier_id, supplier_invoice_number COLLATE NOCASE, financial_year_id) WHERE invoice_kind = 'purchase_invoice' AND document_status <> 'CANCELLED' AND deleted_at IS NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_idempotency ON purchase_invoices (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_purchase_phase2_list ON purchase_invoices (organization_id, financial_year_id, document_status, purchase_date DESC, id DESC)",
      "CREATE INDEX IF NOT EXISTS idx_purchase_phase2_supplier_due ON purchase_invoices (organization_id, supplier_id, outstanding_minor, due_date)",
      "CREATE INDEX IF NOT EXISTS idx_purchase_items_phase2_product ON purchase_invoice_items (organization_id, product_id, purchase_invoice_id)",
      "CREATE INDEX IF NOT EXISTS idx_payment_allocations_document ON payment_allocations (organization_id, document_type, document_id, reversed_at)",
      "CREATE INDEX IF NOT EXISTS idx_payment_allocations_party ON payment_allocations (organization_id, party_type, party_id, allocated_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_party_advances_open ON party_advances (organization_id, party_type, party_id, status, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_bank_reconciliation_status ON bank_reconciliations (organization_id, bank_account_id, status, cleared_date)",
      "CREATE INDEX IF NOT EXISTS idx_period_locks_active ON accounting_period_locks (organization_id, unlocked_at, locked_through DESC)",
      "CREATE INDEX IF NOT EXISTS idx_gst_classification_period ON gst_transaction_classifications (organization_id, financial_year_id, source_type, supply_type, transaction_type)",
      "CREATE INDEX IF NOT EXISTS idx_purchase_attachments_document ON purchase_attachments (organization_id, purchase_invoice_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_attachments_path ON purchase_attachments (organization_id, local_relative_path)",

      `CREATE TRIGGER IF NOT EXISTS trg_purchase_posted_header_immutable
       BEFORE UPDATE OF supplier_id, supplier_name, supplier_invoice_number, supplier_invoice_date, purchase_date,
         bill_date, due_date, payment_terms, reference_no, warehouse_id, place_of_supply, supplier_gstin,
         reverse_charge, purchase_classification, purchase_account_id, gross_minor, discount_minor, taxable_minor,
         cgst_minor, sgst_minor, igst_minor, cess_minor, other_charges_minor, round_off_minor, grand_total_minor,
         financial_year_id, accounting_voucher_id
       ON purchase_invoices FOR EACH ROW
       WHEN OLD.document_status IN ('POSTED', 'CANCELLED')
       BEGIN SELECT RAISE(ABORT, 'posted_purchase_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_purchase_posted_item_insert
       BEFORE INSERT ON purchase_invoice_items FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM purchase_invoices purchase WHERE purchase.id = NEW.purchase_invoice_id AND purchase.document_status = 'POSTED')
       BEGIN SELECT RAISE(ABORT, 'posted_purchase_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_purchase_posted_item_update
       BEFORE UPDATE ON purchase_invoice_items FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM purchase_invoices purchase WHERE purchase.id = OLD.purchase_invoice_id AND purchase.document_status = 'POSTED')
       BEGIN SELECT RAISE(ABORT, 'posted_purchase_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_purchase_posted_item_delete
       BEFORE DELETE ON purchase_invoice_items FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM purchase_invoices purchase WHERE purchase.id = OLD.purchase_invoice_id AND purchase.document_status = 'POSTED')
       BEGIN SELECT RAISE(ABORT, 'posted_purchase_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_sales_posted_exact_header_immutable
       BEFORE UPDATE OF customer_id, customer_name, invoice_number, display_invoice_number, invoice_type,
         invoice_date, date, due_date, subtotal, discount_amount, discount_total, taxable_amount, tax_amount,
         tax_total, total_amount, grand_total, total, financial_year_id, taxable_minor, cgst_minor, sgst_minor,
         igst_minor, cess_minor, grand_total_minor, place_of_supply, customer_gstin, supply_type,
         transaction_type, tax_category
       ON sales_invoices FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_vouchers voucher WHERE voucher.organization_id=OLD.organization_id
         AND voucher.source_type='SALES_INVOICE' AND voucher.source_id=OLD.id AND voucher.status='posted')
       BEGIN SELECT RAISE(ABORT, 'posted_sales_invoice_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_sales_posted_item_update
       BEFORE UPDATE ON sales_invoice_items FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_vouchers voucher JOIN sales_invoices invoice ON invoice.id=OLD.invoice_id
         WHERE voucher.organization_id=OLD.organization_id AND voucher.source_type='SALES_INVOICE'
           AND voucher.source_id=invoice.id AND voucher.status='posted')
       BEGIN SELECT RAISE(ABORT, 'posted_sales_invoice_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_sales_posted_item_delete
       BEFORE DELETE ON sales_invoice_items FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_vouchers voucher JOIN sales_invoices invoice ON invoice.id=OLD.invoice_id
         WHERE voucher.organization_id=OLD.organization_id AND voucher.source_type='SALES_INVOICE'
           AND voucher.source_id=invoice.id AND voucher.status='posted')
       BEGIN SELECT RAISE(ABORT, 'posted_sales_invoice_is_immutable'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_period_lock_voucher_insert
       BEFORE INSERT ON accounting_vouchers FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_period_locks lock WHERE lock.organization_id = NEW.organization_id AND lock.unlocked_at IS NULL AND date(NEW.voucher_date) <= date(lock.locked_through))
       BEGIN SELECT RAISE(ABORT, 'accounting_period_locked'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_period_lock_purchase_insert
       BEFORE INSERT ON purchase_invoices FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_period_locks lock WHERE lock.organization_id = NEW.organization_id AND lock.unlocked_at IS NULL AND date(COALESCE(NEW.purchase_date, NEW.bill_date)) <= date(lock.locked_through))
       BEGIN SELECT RAISE(ABORT, 'accounting_period_locked'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_period_lock_payment_insert
       BEFORE INSERT ON payments FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_period_locks lock WHERE lock.organization_id = NEW.organization_id AND lock.unlocked_at IS NULL AND date(NEW.payment_date) <= date(lock.locked_through))
       BEGIN SELECT RAISE(ABORT, 'accounting_period_locked'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_period_lock_expense_insert
       BEFORE INSERT ON expenses FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_period_locks lock WHERE lock.organization_id = NEW.organization_id AND lock.unlocked_at IS NULL AND date(NEW.expense_date) <= date(lock.locked_through))
       BEGIN SELECT RAISE(ABORT, 'accounting_period_locked'); END`,
      `CREATE TRIGGER IF NOT EXISTS trg_period_lock_credit_note_insert
       BEFORE INSERT ON credit_notes FOR EACH ROW
       WHEN EXISTS (SELECT 1 FROM accounting_period_locks lock WHERE lock.organization_id = NEW.organization_id AND lock.unlocked_at IS NULL AND date(NEW.note_date) <= date(lock.locked_through))
       BEGIN SELECT RAISE(ABORT, 'accounting_period_locked'); END`,
    ],
  },
  {
    version: 21,
    name: "accounting_phase_two_opening_party_allocations",
    sql: [
      `CREATE TABLE payment_allocations_v21 (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
        payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
        party_type TEXT NOT NULL CHECK (party_type IN ('supplier', 'customer')),
        party_id TEXT NOT NULL,
        document_type TEXT NOT NULL CHECK (document_type IN ('purchase_invoice', 'sales_invoice', 'supplier_opening', 'customer_opening')),
        document_id TEXT NOT NULL,
        allocation_minor INTEGER NOT NULL CHECK (allocation_minor > 0),
        allocated_at TEXT NOT NULL,
        reversed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, payment_id, document_type, document_id)
      )`,
      `INSERT INTO payment_allocations_v21 (
        id, organization_id, financial_year_id, payment_id, party_type, party_id, document_type,
        document_id, allocation_minor, allocated_at, reversed_at, created_at
       ) SELECT id, organization_id, financial_year_id, payment_id, party_type, party_id, document_type,
         document_id, allocation_minor, allocated_at, reversed_at, created_at FROM payment_allocations`,
      "DROP TABLE payment_allocations",
      "ALTER TABLE payment_allocations_v21 RENAME TO payment_allocations",

      `CREATE TABLE advance_allocations_v21 (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        financial_year_id TEXT NOT NULL REFERENCES financial_years(id) ON DELETE RESTRICT,
        advance_id TEXT NOT NULL REFERENCES party_advances(id) ON DELETE RESTRICT,
        document_type TEXT NOT NULL CHECK (document_type IN ('purchase_invoice', 'sales_invoice', 'supplier_opening', 'customer_opening')),
        document_id TEXT NOT NULL,
        allocation_minor INTEGER NOT NULL CHECK (allocation_minor > 0),
        accounting_voucher_id TEXT NOT NULL REFERENCES accounting_vouchers(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, advance_id, document_type, document_id)
      )`,
      `INSERT INTO advance_allocations_v21 (
        id, organization_id, financial_year_id, advance_id, document_type, document_id,
        allocation_minor, accounting_voucher_id, created_at
       ) SELECT id, organization_id, financial_year_id, advance_id, document_type, document_id,
         allocation_minor, accounting_voucher_id, created_at FROM advance_allocations`,
      "DROP TABLE advance_allocations",
      "ALTER TABLE advance_allocations_v21 RENAME TO advance_allocations",

      "CREATE INDEX idx_payment_allocations_document ON payment_allocations (organization_id, document_type, document_id, reversed_at)",
      "CREATE INDEX idx_payment_allocations_party ON payment_allocations (organization_id, party_type, party_id, allocated_at DESC)",
      "CREATE INDEX idx_advance_allocations_document ON advance_allocations (organization_id, document_type, document_id)",
    ],
  },
]
