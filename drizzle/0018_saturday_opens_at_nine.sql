-- Owner correction (2026-08-30), second half: Saturday is 9am-6pm.
--
-- 0017 moved only the closing time, because the seed still said 5pm. The live
-- row had already been edited in Admin to 10:00-18:00, so the close was a no-op
-- and the open was left an hour late. Both ends are set here so the row matches
-- what the owner asked for whatever it currently holds.
--
-- Saturday only, and only if it is open — a shop that has since closed
-- Saturdays in Admin stays closed.
UPDATE "business_hours"
SET "open" = '09:00', "close" = '18:00', "updated_at" = now()
WHERE "weekday" = 6 AND "closed" = false;
