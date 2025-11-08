-- === MESO SQL.js Schema ===
-- Локальная БД без авторизации
-- Schema Version: 3

create table if not exists schema_version (
  version integer primary key,
  applied_at datetime default current_timestamp,
  description text
);

create table if not exists plan (
  id integer primary key autoincrement,
  day text not null,
  exercise text not null,
  setrep text,
  type text check (type in ('A','B','C','D')),
  rir_w1 text,
  rir_w2 text,
  rir_w3 text,
  rir_w4 text,
  note text,
  created_at datetime default current_timestamp
);

create table if not exists tm (
  id integer primary key autoincrement,
  exercise text not null unique,
  tm_kg real,
  updated_at datetime default current_timestamp,
  locked integer default 0,
  source text default 'auto'
);

create table if not exists tracker (
  id integer primary key autoincrement,
  date date not null,
  week integer,
  day text,
  exercise text not null,
  set_no integer,
  weight real,
  reps integer,
  rir real,
  rpe real,
  target_rir text,
  e1rm real,
  note text,
  created_at datetime default current_timestamp
);

create table if not exists sessions (
  id integer primary key autoincrement,
  date date not null,
  week integer,
  day text,
  status text check (status in ('open','done')) default 'open',
  note text,
  created_at datetime default current_timestamp
);

create table if not exists profile (
  id integer primary key autoincrement,
  unit text default 'kg',
  weight_step real default 2.5,
  show_only_work integer default 0,
  theme text default 'light',
  created_at datetime default current_timestamp
);

create index if not exists idx_tracker_date on tracker(date desc);
create index if not exists idx_tracker_exercise on tracker(exercise, date desc);
create index if not exists idx_sessions_date on sessions(date desc);

-- Views
create view if not exists v_last_sets as
select t.exercise, t.weight, t.reps, t.rir, t.date
from (
  select *, row_number() over (partition by exercise order by date desc, id desc) as rn
  from tracker
) t
where t.rn = 1;

create view if not exists v_best_e1rm as
select x.exercise, x.best_e1rm, x.date
from (
  select exercise,
         max(e1rm) as best_e1rm,
         min(date) as date
  from tracker
  where e1rm is not null
  group by exercise
) x;

create view if not exists v_weekly_volume as
with base as (
  select tr.week, tr.exercise, tr.weight, tr.reps, tr.target_rir, tr.rir,
         (tr.weight * tr.reps) as ton,
         p.type
  from tracker tr
  left join plan p on p.exercise = tr.exercise
)
select week,
       count(*) as sets,
       sum(reps) as reps,
       coalesce(sum(ton),0) as tonnage,
       avg(abs(
         case 
           when target_rir glob '[0-9]*' then cast(target_rir as real) 
           else null 
         end - rir
       )) as avg_rir_diff,
       sum(case when type='A' then 1 else 0 end) as a_sets,
       sum(case when type='B' then 1 else 0 end) as b_sets,
       sum(case when type='C' then 1 else 0 end) as c_sets,
       sum(case when type='D' then 1 else 0 end) as d_sets
from base
group by week;


