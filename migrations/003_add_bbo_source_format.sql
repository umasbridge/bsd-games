-- Migration: Allow 'bbo' as a source_format (BBO My Hands scraper)

alter table bg_tournaments drop constraint bg_tournaments_source_format_check;
alter table bg_tournaments add constraint bg_tournaments_source_format_check
  check (source_format in ('srini', 'bridgewebs', 'sg', 'lovebridge', 'bbo'));
