-- Ceramic coating is booked by DATE; the shop confirms the time by phone.
--
-- Additive and defaulted, so every existing appointment keeps a real time and
-- nothing about the current schedule moves. A true row holds no bay and no
-- staff member and is skipped by the availability engine — see DECISIONS.md #27.
ALTER TABLE "appointments" ADD COLUMN "time_to_be_confirmed" boolean DEFAULT false NOT NULL;
