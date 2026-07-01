output "public_ip" {
  value = aws_instance.witness.public_ip
}

output "private_ip" {
  value = aws_instance.witness.private_ip
}

output "instance_id" {
  value = aws_instance.witness.id
}
