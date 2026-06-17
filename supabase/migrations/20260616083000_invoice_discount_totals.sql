alter table if exists public.invoices
  add column if not exists discount_amount numeric default 0,
  add column if not exists discount_total numeric default 0,
  add column if not exists taxable_amount numeric default 0;

update public.invoices
set
  discount_amount = coalesce(discount_amount, discount_total, 0),
  discount_total = coalesce(discount_total, discount_amount, 0),
  taxable_amount = coalesce(
    taxable_amount,
    greatest(0, coalesce(subtotal, 0) - coalesce(discount_amount, discount_total, 0))
  )
where
  discount_amount is null
  or discount_total is null
  or taxable_amount is null;
