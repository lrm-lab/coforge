SET lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.coforge_sys_person(uuid, text, text), public.coforge_sys_task(uuid, int, text);

RESET lock_timeout;
