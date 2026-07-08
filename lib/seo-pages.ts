export type SeoFaq = {
  question: string
  answer: string
}

export type SeoLandingPage = {
  slug: string
  title: string
  metaTitle: string
  metaDescription: string
  eyebrow: string
  summary: string
  primaryKeyword: string
  sections: Array<{
    heading: string
    body: string
  }>
  benefits: string[]
  useCases: string[]
  faqs: SeoFaq[]
}

const commonBenefits = [
  "Cloud access for teams and owners",
  "Inventory, billing, customers, and analytics in one workspace",
  "GST-ready invoices and professional print formats",
  "Role-based access for growing businesses",
]

export const seoLandingPages: SeoLandingPage[] = [
  {
    slug: "inventory-management-software",
    title: "Inventory Management Software for Retail, Wholesale, and Service Businesses",
    metaTitle: "Inventory Management Software | Bezgrow",
    metaDescription: "Bezgrow inventory management software helps businesses manage stock, batches, suppliers, warehouses, expiry tracking, and inventory movement from one cloud platform.",
    eyebrow: "Inventory Software",
    summary: "Manage stock, batches, suppliers, warehouses, expiry tracking, purchase readiness, and movement history from one fast cloud inventory platform.",
    primaryKeyword: "inventory management software",
    sections: [
      {
        heading: "Cloud Inventory Management",
        body: "Bezgrow helps teams track product quantities, low-stock items, inventory value, product categories, units, GST rates, and movement logs without switching tools.",
      },
      {
        heading: "Stock Control for Daily Operations",
        body: "Use Bezgrow to keep stock records clean across sales, adjustments, transfers, and product updates so business owners can see accurate inventory health.",
      },
    ],
    benefits: ["Stock tracking", "Batch and expiry support", "Low stock visibility", "Supplier-ready product records", ...commonBenefits],
    useCases: ["Retail stores", "Wholesale distributors", "Medical shops", "Service businesses"],
    faqs: [
      {
        question: "What is inventory management software?",
        answer: "Inventory management software helps businesses track products, stock quantities, purchases, sales, adjustments, and inventory value from one system.",
      },
      {
        question: "Does Bezgrow support GST-ready inventory records?",
        answer: "Yes. Bezgrow stores product GST, HSN, rate, unit, stock, and billing information so inventory can connect with invoices.",
      },
    ],
  },
  {
    slug: "gst-billing-software",
    title: "GST Billing Software for Tax Invoices, Retail Bills, and Wholesale Billing",
    metaTitle: "GST Billing Software | Bezgrow",
    metaDescription: "Create GST-compliant invoices, retail bills, wholesale invoices, A4 invoices, compact bills, and thermal receipts with Bezgrow GST billing software.",
    eyebrow: "GST Billing",
    summary: "Generate GST-ready invoices with products, tax calculations, customer details, payment status, and professional print formats.",
    primaryKeyword: "GST billing software",
    sections: [
      {
        heading: "GST Invoice Creation",
        body: "Create tax invoices with product rates, GST percentage, discounts, taxable value, payment mode, customer information, and invoice totals.",
      },
      {
        heading: "Professional Invoice Printing",
        body: "Bezgrow supports invoice workflows for A4 invoices, compact bills, thermal receipts, and shareable public invoice links.",
      },
    ],
    benefits: ["GST invoice generation", "Payment status tracking", "A4 and thermal print support", "Customer billing records", ...commonBenefits],
    useCases: ["Retail billing", "Wholesale invoicing", "Service invoices", "GST tax invoice workflows"],
    faqs: [
      {
        question: "Can Bezgrow create GST invoices?",
        answer: "Yes. Bezgrow can create GST invoices with product tax rates, taxable amount, GST amount, total amount, and customer details.",
      },
      {
        question: "Does Bezgrow support invoice sharing?",
        answer: "Yes. Businesses can share invoice links and use print-ready invoice pages for customer access.",
      },
    ],
  },
  {
    slug: "retail-pos-software",
    title: "Retail POS Software for Fast Billing, Barcode Sales, and Store Management",
    metaTitle: "Retail POS Software | Bezgrow",
    metaDescription: "Bezgrow retail POS software helps stores manage fast billing, barcode scanning, customer records, payment tracking, thermal printing, and analytics.",
    eyebrow: "Retail POS",
    summary: "Run store billing with fast product selection, customer records, inventory updates, payment tracking, and print-ready receipts.",
    primaryKeyword: "retail POS software",
    sections: [
      {
        heading: "Fast Retail Billing",
        body: "Bezgrow is built for retail teams that need quick checkout, accurate product records, customer details, and smooth invoice creation.",
      },
      {
        heading: "POS Connected With Inventory",
        body: "Every sale can connect with stock control, product availability, invoice records, and business analytics.",
      },
    ],
    benefits: ["Quick billing", "Barcode-ready workflows", "Customer management", "Thermal receipt support", ...commonBenefits],
    useCases: ["Retail shops", "Mini marts", "Counters", "Multi-product stores"],
    faqs: [
      {
        question: "What is retail POS software?",
        answer: "Retail POS software helps stores create bills, manage customers, accept payments, print receipts, and track sales operations.",
      },
      {
        question: "Can Bezgrow be used for retail billing?",
        answer: "Yes. Bezgrow supports retail billing workflows with products, customers, invoices, payment tracking, and receipt printing.",
      },
    ],
  },
  {
    slug: "wholesale-inventory-management-software",
    title: "Wholesale Inventory Management Software for Distributors and Stock Teams",
    metaTitle: "Wholesale Inventory Management Software | Bezgrow",
    metaDescription: "Manage wholesale stock, suppliers, distributors, customer billing, stock transfers, warehouses, purchases, and bulk invoices with Bezgrow.",
    eyebrow: "Wholesale Inventory",
    summary: "Manage larger product catalogs, stock movement, bulk billing, customer records, and warehouse-ready workflows from one workspace.",
    primaryKeyword: "wholesale inventory management software",
    sections: [
      {
        heading: "Wholesale Stock Visibility",
        body: "Bezgrow helps wholesalers see product stock, product value, low-stock risks, customer billing history, and invoice activity in one platform.",
      },
      {
        heading: "Distributor Billing Workflows",
        body: "Create professional invoices, manage customer records, and keep product movement connected with sales operations.",
      },
    ],
    benefits: ["Bulk product management", "Distributor-ready records", "Wholesale invoice formats", "Stock movement visibility", ...commonBenefits],
    useCases: ["Distributors", "Wholesalers", "B2B sellers", "Warehouse operators"],
    faqs: [
      {
        question: "Is Bezgrow suitable for wholesalers?",
        answer: "Yes. Bezgrow is designed for wholesale inventory, customer records, product catalogs, billing, and operational reporting.",
      },
      {
        question: "Can wholesale teams manage invoices and inventory together?",
        answer: "Yes. Bezgrow connects invoices with products, customer records, payment status, and inventory visibility.",
      },
    ],
  },
  {
    slug: "erp-software",
    title: "ERP Software for Inventory, Billing, Customers, Analytics, and Admin Control",
    metaTitle: "ERP Software | Bezgrow",
    metaDescription: "Bezgrow ERP software combines inventory, GST billing, customers, orders, analytics, admin workflows, and business management in one cloud platform.",
    eyebrow: "Cloud ERP",
    summary: "Bring inventory, billing, customers, orders, analytics, license-based access, and administration into one professional ERP workspace.",
    primaryKeyword: "ERP software",
    sections: [
      {
        heading: "ERP for Modern Businesses",
        body: "Bezgrow gives growing businesses one place to manage daily operations, product data, customer records, invoices, and decision-ready analytics.",
      },
      {
        heading: "Admin and Team Control",
        body: "License-based access, organization membership, and admin workflows help businesses manage teams with better control.",
      },
    ],
    benefits: ["Inventory ERP", "Billing ERP", "Customer records", "Offline licenses", ...commonBenefits],
    useCases: ["SMBs", "Retail chains", "Wholesale businesses", "Service teams"],
    faqs: [
      {
        question: "What does ERP software do?",
        answer: "ERP software combines business workflows such as inventory, billing, customers, orders, reports, and administration in one system.",
      },
      {
        question: "Is Bezgrow a cloud ERP?",
        answer: "Yes. Bezgrow is a cloud-based ERP workspace for inventory, billing, customers, analytics, and business operations.",
      },
    ],
  },
  {
    slug: "barcode-billing-software",
    title: "Barcode Billing Software for Faster Product Billing and POS Workflows",
    metaTitle: "Barcode Billing Software | Bezgrow",
    metaDescription: "Use Bezgrow barcode billing software for fast product lookup, retail billing, POS workflows, GST invoices, and inventory-connected sales.",
    eyebrow: "Barcode Billing",
    summary: "Speed up billing with barcode-ready product records, fast item selection, GST invoice creation, and stock-connected workflows.",
    primaryKeyword: "barcode billing software",
    sections: [
      {
        heading: "Barcode-Ready Product Billing",
        body: "Store product barcode information and use product records for faster billing, cleaner item selection, and fewer manual billing mistakes.",
      },
      {
        heading: "Billing Connected With Stock",
        body: "Barcode billing workflows work best when products, stock, rates, GST, and invoices are connected in one system.",
      },
    ],
    benefits: ["Barcode product records", "Fast checkout workflows", "GST billing", "Retail POS support", ...commonBenefits],
    useCases: ["Retail stores", "Pharmacies", "Supermarkets", "Counter billing"],
    faqs: [
      {
        question: "What is barcode billing software?",
        answer: "Barcode billing software helps businesses find products quickly during billing using barcode records and connected product data.",
      },
      {
        question: "Can Bezgrow manage barcode-ready products?",
        answer: "Yes. Bezgrow supports product records with barcode fields, pricing, GST, stock, and invoice workflows.",
      },
    ],
  },
  {
    slug: "pharmacy-inventory-software",
    title: "Pharmacy Inventory Software for Medicine Stock, Batches, and Expiry Tracking",
    metaTitle: "Pharmacy Inventory Software | Bezgrow",
    metaDescription: "Bezgrow pharmacy inventory software helps medical businesses manage medicine stock, batches, expiry dates, GST billing, and customer invoices.",
    eyebrow: "Pharmacy Inventory",
    summary: "Track medicine stock, batch details, expiry risks, product rates, GST billing, and inventory movement for pharmacy operations.",
    primaryKeyword: "pharmacy inventory software",
    sections: [
      {
        heading: "Medicine Stock and Expiry Control",
        body: "Bezgrow supports pharmacy-style inventory workflows with product records, batch readiness, expiry visibility, and billing integration.",
      },
      {
        heading: "GST Billing for Pharmacies",
        body: "Generate professional invoices and maintain customer billing records for pharmacy, medical, and healthcare retail operations.",
      },
    ],
    benefits: ["Batch-ready records", "Expiry tracking workflows", "Medicine product catalog", "GST billing", ...commonBenefits],
    useCases: ["Pharmacies", "Medical distributors", "Healthcare stores", "Medicine wholesalers"],
    faqs: [
      {
        question: "Can Bezgrow be used by pharmacies?",
        answer: "Yes. Bezgrow can support pharmacy inventory workflows, product records, billing, stock tracking, and expiry-aware operations.",
      },
      {
        question: "Does Bezgrow support batch and expiry tracking?",
        answer: "Bezgrow is designed with batch and expiry-ready invoice and inventory structures for medical and pharmacy businesses.",
      },
    ],
  },
  {
    slug: "medical-store-billing-software",
    title: "Medical Store Billing Software for GST Bills, Medicine Sales, and Stock Control",
    metaTitle: "Medical Store Billing Software | Bezgrow",
    metaDescription: "Create medical store bills, GST invoices, medicine sales records, customer invoices, and inventory-connected billing with Bezgrow.",
    eyebrow: "Medical Store Billing",
    summary: "Create medical store bills with medicine products, GST, customer details, payment status, and professional invoice output.",
    primaryKeyword: "medical store billing software",
    sections: [
      {
        heading: "Medical Store Invoice Workflows",
        body: "Bezgrow helps medical stores create invoices, track payments, manage customers, and connect sales with inventory records.",
      },
      {
        heading: "Professional Billing Output",
        body: "Use print-ready invoice formats, customer information, GST details, and shareable invoice links for smoother customer service.",
      },
    ],
    benefits: ["Medical billing", "GST invoices", "Customer records", "Medicine inventory connection", ...commonBenefits],
    useCases: ["Medical stores", "Healthcare retailers", "Pharma counters", "Medicine shops"],
    faqs: [
      {
        question: "Is Bezgrow useful for medical store billing?",
        answer: "Yes. Bezgrow supports product billing, customer records, GST invoices, payment tracking, and inventory-connected workflows.",
      },
      {
        question: "Can medical stores print invoices with Bezgrow?",
        answer: "Yes. Bezgrow includes print-ready invoice pages for professional billing output.",
      },
    ],
  },
  {
    slug: "cloud-inventory-management-software",
    title: "Cloud Inventory Management Software for Real-Time Business Operations",
    metaTitle: "Cloud Inventory Management Software | Bezgrow",
    metaDescription: "Use Bezgrow cloud inventory management software to manage stock, products, customers, invoices, reports, and business operations from anywhere.",
    eyebrow: "Cloud Inventory",
    summary: "Manage products, stock, customers, billing, reports, and business operations securely from a cloud-based ERP workspace.",
    primaryKeyword: "cloud inventory management software",
    sections: [
      {
        heading: "Inventory Access From Anywhere",
        body: "Bezgrow helps owners and teams access business records through the browser, with installable PWA support for mobile and desktop.",
      },
      {
        heading: "Cloud Billing and Reporting",
        body: "Connect stock, invoices, customer records, payments, and analytics so the business has a cleaner operational view.",
      },
    ],
    benefits: ["Cloud access", "PWA installability", "Team-ready workflows", "Inventory analytics", ...commonBenefits],
    useCases: ["Growing teams", "Multi-device businesses", "Retail owners", "Wholesale operators"],
    faqs: [
      {
        question: "What is cloud inventory management software?",
        answer: "Cloud inventory management software lets businesses manage stock and product records online from supported devices.",
      },
      {
        question: "Is Bezgrow cloud-based?",
        answer: "Yes. Bezgrow is a cloud-based ERP and inventory workspace built for browser, mobile, and desktop use.",
      },
    ],
  },
  {
    slug: "business-management-software",
    title: "Business Management Software for Inventory, Billing, Customers, and Reports",
    metaTitle: "Business Management Software | Bezgrow",
    metaDescription: "Bezgrow business management software helps teams manage inventory, GST billing, customers, invoices, orders, analytics, and admin workflows.",
    eyebrow: "Business Management",
    summary: "Run inventory, billing, customers, invoices, orders, analytics, and admin workflows from one business management platform.",
    primaryKeyword: "business management software",
    sections: [
      {
        heading: "One Platform for Business Operations",
        body: "Bezgrow brings core business workflows together so owners can manage records, billing, stock, customers, and analytics without scattered tools.",
      },
      {
        heading: "Built for Launch and Growth",
        body: "Approval-based access, organization controls, professional invoice pages, and dashboards help businesses operate with more confidence.",
      },
    ],
    benefits: ["Inventory management", "Billing management", "Customer records", "Business analytics", ...commonBenefits],
    useCases: ["Retail businesses", "Wholesale businesses", "Service companies", "Owner-led teams"],
    faqs: [
      {
        question: "What is business management software?",
        answer: "Business management software helps companies manage daily operations such as inventory, billing, customers, orders, reports, and team access.",
      },
      {
        question: "What can Bezgrow manage?",
        answer: "Bezgrow can manage inventory, GST billing, customer records, invoices, orders, analytics, and admin workflows.",
      },
    ],
  },
]

export function getSeoLandingPage(slug: string) {
  return seoLandingPages.find((page) => page.slug === slug)
}
