-- مخطط مرجعي PostgreSQL لطبقة الإنتاج والتسويق.
-- لا يُنفذ في النسخة HTML الحالية؛ يحفظ كعقد بيانات للانتقال اللاحق إلى backend.

create table field_season (
  season_id uuid primary key,
  field_id text not null,
  crop_id text not null,
  season_label text,
  area_value numeric(14,3) not null,
  area_unit text not null check (area_unit in ('m2','dunum','hectare')),
  irrigation_mode text check (irrigation_mode in ('irrigated','rainfed','mixed')),
  planting_date date,
  expected_first_harvest date,
  expected_last_harvest date,
  status text not null default 'planned' check (status in ('planned','active','harvested','closed')),
  created_at timestamptz not null default now()
);

create table production_plan (
  plan_id uuid primary key,
  season_id uuid not null references field_season(season_id),
  expected_yield numeric(14,3),
  yield_unit text,
  expected_marketable_rate numeric(8,5),
  expected_loss_rate numeric(8,5),
  target_first_grade_rate numeric(8,5),
  source_type text not null check (source_type in ('user','advisor','local_table','history','model')),
  status text not null default 'estimated' check (status in ('planned','estimated','superseded')),
  notes text,
  created_at timestamptz not null default now()
);

create table operation_event (
  operation_id uuid primary key,
  season_id uuid not null references field_season(season_id),
  operation_type text not null,
  event_date date not null,
  planned_or_actual text not null check (planned_or_actual in ('planned','actual','estimated')),
  quantity numeric(14,3),
  unit text,
  unit_price numeric(14,4),
  currency text,
  total_cost numeric(14,4),
  source_type text,
  invoice_ref text,
  notes text,
  record_status text not null default 'actual' check (record_status in ('planned','actual','estimated','cancelled','superseded')),
  created_at timestamptz not null default now()
);

create table harvest_event (
  harvest_id uuid primary key,
  season_id uuid not null references field_season(season_id),
  harvest_date date not null,
  gross_quantity numeric(14,3) not null,
  unit text not null,
  marketable_quantity numeric(14,3),
  rejected_quantity numeric(14,3),
  source_type text not null check (source_type in ('actual','estimated')),
  notes text,
  created_at timestamptz not null default now()
);

create table harvest_lot (
  lot_id uuid primary key,
  harvest_id uuid not null references harvest_event(harvest_id),
  lot_code text not null,
  grade text not null,
  quantity numeric(14,3) not null,
  unit text not null,
  quality_notes text,
  created_at timestamptz not null default now()
);

create table market_price (
  market_price_id uuid primary key,
  crop_id text not null,
  grade text,
  market_name text,
  price numeric(14,4) not null,
  unit text not null,
  currency text not null,
  observed_at timestamptz not null,
  price_type text not null check (price_type in ('farm_gate','wholesale','retail','contract','processing')),
  source_type text not null check (source_type in ('user','advisor','invoice','external')),
  source_ref text,
  confidence text check (confidence in ('low','medium','high')),
  notes text
);

create table sale_transaction (
  sale_id uuid primary key,
  season_id uuid not null references field_season(season_id),
  buyer_name text,
  channel text not null,
  sale_date date not null,
  quantity numeric(14,3) not null,
  unit text not null,
  grade text,
  unit_price numeric(14,4) not null,
  currency text not null,
  commission numeric(14,4) not null default 0,
  transport_cost numeric(14,4) not null default 0,
  packaging_cost numeric(14,4) not null default 0,
  other_cost numeric(14,4) not null default 0,
  collection_status text not null default 'uncollected' check (collection_status in ('uncollected','partial','collected')),
  notes text,
  created_at timestamptz not null default now()
);

create table sale_allocation (
  sale_id uuid not null references sale_transaction(sale_id),
  lot_id uuid not null references harvest_lot(lot_id),
  quantity numeric(14,3) not null,
  primary key (sale_id, lot_id)
);

create index operation_event_season_date_idx on operation_event(season_id, event_date);
create index harvest_event_season_date_idx on harvest_event(season_id, harvest_date);
create index sale_transaction_season_date_idx on sale_transaction(season_id, sale_date);
create index market_price_crop_date_idx on market_price(crop_id, observed_at);
