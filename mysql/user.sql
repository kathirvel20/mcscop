LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (1,'admin','$2a$10$SW9AmmAlVCM3OSkzMzCEb.NpYXQ67qG5lBmk7U85YbXWhTkTZwEXi','admin','','all','abc123','0','2016-10-06 23:21:50');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

CREATE USER 'mcscop'@'localhost' IDENTIFIED BY 'MCScoppass123!@#';
GRANT ALL PRIVILEGES ON mcscop.* TO `mcscop`@`localhost`;
FLUSH PRIVILEGES;
