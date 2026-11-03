CREATE TABLE `device_profile_scopes` (
	`device_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`device_id`, `profile_id`),
	FOREIGN KEY (`device_id`,`profile_id`) REFERENCES `device_profiles`(`device_id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "device_permission" CHECK("device_profile_scopes"."permission" IN ('read','write'))
);
