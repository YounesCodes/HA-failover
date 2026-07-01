output "app_names" {
  value = [for i in aws_instance.app : i.tags["Name"]]
}

output "app_public_ips" {
  value = aws_eip.app[*].public_ip
}

output "app_private_ips" {
  value = aws_instance.app[*].private_ip
}

output "app_instance_ids" {
  value = aws_instance.app[*].id
}
