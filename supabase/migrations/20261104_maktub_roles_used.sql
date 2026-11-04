-- Maktub: superadmin role, used-voucher flag, accurate revenue dates, unused counts.

alter table public.admin_users drop constraint if exists admin_users_role_check;
alter table public.admin_users add constraint admin_users_role_check
  check (role in ('super_admin','owner','viewer'));

insert into public.admin_users (tenant_id, username, password_hash, role)
values (1, 'superadmin', '__SUPER_HASH__', 'super_admin')
on conflict (username) do update
  set password_hash = excluded.password_hash, role = 'super_admin';

alter table public.mikrotik_users add column if not exists used boolean not null default false;

-- A row is "used" if it has ever been seen/logged in or has an expiry.
update public.mikrotik_users
   set used = true
 where first_login_at is not null or last_seen is not null or expires_at is not null;

-- Activation time = expiry - plan duration. This backfills historical vouchers
-- so today/week/month revenue are genuinely different.
update public.mikrotik_users
   set first_login_at = expires_at - case plan
     when '24hr' then interval '1 day'
     when '3d'   then interval '3 days'
     when '5d'   then interval '5 days'
     when '7d'   then interval '7 days'
     when '14d'  then interval '14 days'
     when '30d'  then interval '30 days'
     else null end
 where expires_at is not null
   and plan in ('24hr','3d','5d','7d','14d','30d');

drop function if exists public.maktub_network_stats();

create or replace function public.maktub_network_stats()
returns table (
  network_id uuid,
  online bigint,
  expired bigint,
  active bigint,
  total bigint,
  unused bigint,
  revenue_today bigint,
  revenue_week bigint,
  revenue_month bigint
)
language sql stable as $$
  with base as (
    select n.id as network_id,
           n.plan_prices,
           u.id as user_id,
           u.plan,
           u.status,
           u.expires_at,
           u.last_seen,
           u.first_login_at,
           u.used
    from public.networks n
    left join public.mikrotik_users u on u.network_id = n.id
    where n.status = 'active'
  ),
  d as (select (now() at time zone 'Africa/Lagos')::date as today)
  select
    b.network_id,
    count(b.user_id) filter (
      where b.used
        and b.last_seen > now() - interval '3 minutes'
        and b.status = 'active'
        and (b.expires_at is null or b.expires_at > now())
    ) as online,
    count(b.user_id) filter (
      where b.used
        and (b.status = 'expired' or (b.expires_at is not null and b.expires_at <= now()))
    ) as expired,
    count(b.user_id) filter (
      where b.used
        and b.status = 'active'
        and (b.expires_at is null or b.expires_at > now())
    ) as active,
    count(b.user_id) as total,
    count(b.user_id) filter (where not b.used) as unused,
    coalesce(sum((b.plan_prices->>b.plan)::int) filter (
      where b.used and (b.first_login_at at time zone 'Africa/Lagos')::date = (select today from d)
    ), 0)::bigint as revenue_today,
    coalesce(sum((b.plan_prices->>b.plan)::int) filter (
      where b.used and (b.first_login_at at time zone 'Africa/Lagos')::date >= (select today - 6 from d)
    ), 0)::bigint as revenue_week,
    coalesce(sum((b.plan_prices->>b.plan)::int) filter (
      where b.used and (b.first_login_at at time zone 'Africa/Lagos')::date >= date_trunc('month', (select today from d))::date
    ), 0)::bigint as revenue_month
  from base b
  group by b.network_id, b.plan_prices;
$$;

grant execute on function public.maktub_network_stats() to service_role;

-- The users list only ever shows vouchers that have been used/logged in.
create or replace function public.maktub_users(
  p_network uuid,
  p_search text default '',
  p_status text default 'all',
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  username text,
  plan text,
  profile text,
  mac_address text,
  status text,
  expires_at timestamptz,
  first_login_at timestamptz,
  last_seen timestamptz,
  online boolean,
  total_count bigint
)
language sql stable as $$
  with filtered as (
    select u.*,
           (u.last_seen > now() - interval '3 minutes') as is_online
    from public.mikrotik_users u
    where u.network_id = p_network
      and u.used = true
      and (
        p_search = ''
        or u.username ilike '%' || p_search || '%'
        or coalesce(u.mac_address, '') ilike '%' || p_search || '%'
      )
      and (
        p_status = 'all'
        or (p_status = 'online' and u.status = 'active'
            and (u.expires_at is null or u.expires_at > now())
            and u.last_seen > now() - interval '3 minutes')
        or (p_status = 'active' and u.status = 'active'
            and (u.expires_at is null or u.expires_at > now()))
        or (p_status = 'expired' and (u.status = 'expired'
            or (u.expires_at is not null and u.expires_at <= now())))
      )
  )
  select f.username, f.plan, f.profile, f.mac_address, f.status,
         f.expires_at, f.first_login_at, f.last_seen, f.is_online,
         count(*) over() as total_count
  from filtered f
  order by (f.last_seen is null), f.last_seen desc, f.username asc
  limit greatest(p_limit, 1) offset greatest(p_offset, 0);
$$;
