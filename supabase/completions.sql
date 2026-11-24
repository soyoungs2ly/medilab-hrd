-- 수료 확인용 표 (슈파베이스 SQL Editor에서 한 번 실행)
-- 인사팀은 Table Editor에서 completions 표에 직원별 수료 기록을 넣으면 됩니다.

create table if not exists public.completions (
  id           bigint generated always as identity primary key,
  name         text not null,                                   -- 이름 (예: 홍길동)
  name_key     text generated always as (regexp_replace(name, '\s', '', 'g')) stored,
  birth        text not null check (birth ~ '^[0-9]{6}$'),      -- 생년월일 6자리 (예: 900115)
  course       text not null check (course in ('리더십 과정', '신입 사원 과정', '법정교육')),
  status       text not null default '미수료' check (status in ('수료', '진행 중', '미수료')),
  completed_on date,                                            -- 수료일 (수료일 때만)
  created_at   timestamptz not null default now(),
  unique (name, birth, course)
);

create index if not exists completions_lookup on public.completions (name_key, birth);

create table if not exists public.lookup_attempts (
  id         bigint generated always as identity primary key,
  ip_hash    text not null,                                     -- 접속 위치를 알아볼 수 없게 바꾼 값
  created_at timestamptz not null default now()
);

create index if not exists lookup_attempts_recent on public.lookup_attempts (ip_hash, created_at);

-- 외부에서 직접 읽거나 쓰지 못하게 잠급니다. (사이트 서버만 비밀 키로 접근)
alter table public.completions enable row level security;
alter table public.lookup_attempts enable row level security;
