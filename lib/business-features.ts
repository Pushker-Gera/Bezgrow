export const businessTypeFeatures: Record<
    string,
    string[]
> = {

    retail: [
        "barcode_scanning",
        "pos_billing",
        "quick_checkout",
    ],

    wholesale: [
        "bulk_pricing",
        "gst_b2b",
        "purchase_orders",
    ],

    online_store: [
        "shipping_labels",
        "parcel_qr",
        "awb_tracking",
        "thermal_printing",
    ],

    distributor: [
        "warehouse_transfers",
        "bulk_inventory",
    ],

    restaurant: [
        "kot_printing",
        "table_management",
    ],

    pharmacy: [
        "expiry_tracking",
        "batch_tracking",
        "prescription_upload",
    ],

    manufacturer: [
        "raw_materials",
        "production_batches",
    ],

    service_business: [
        "quotation_system",
        "service_invoices",
    ],
}

export const categoryFeatures: Record<
    string,
    string[]
> = {

    medicine: [
        "expiry_tracking",
        "batch_tracking",
        "prescription_required",
    ],

    cosmetics: [
        "batch_tracking",
    ],

    garments: [
        "size_variants",
        "color_variants",
    ],

    grocery: [
        "weight_inventory",
        "expiry_tracking",
    ],

    electronics: [
        "serial_numbers",
        "warranty_tracking",
    ],

    confectionary: [
        "expiry_tracking",
        "recipe_tracking",
    ],

    jewellery: [
        "weight_tracking",
        "purity_tracking",
    ],
}