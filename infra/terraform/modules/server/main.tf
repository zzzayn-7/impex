# The server: one EC2 instance running the Docker Compose stack, a separate data disk (Docker's data directory: images, the PostgreSQL volume, the uploaded logos) that
# outlives the server, and daily snapshots of that disk.

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_ebs_volume" "data" {
  availability_zone = var.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "${var.name}-data", Backup = "impex" }

  lifecycle {
    prevent_destroy = true # the databases live here: terraform refuses to destroy it
  }
}

resource "aws_instance" "this" {
  ami                     = data.aws_ssm_parameter.al2023.value
  instance_type           = var.instance_type
  subnet_id               = var.subnet_id
  vpc_security_group_ids  = [var.security_group_id]
  iam_instance_profile    = var.instance_profile_name
  disable_api_termination = var.termination_protection
  monitoring              = false

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1          # a container on the server cannot reach the metadata service, so it can never borrow the server's AWS role
  }

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/files/user_data.sh.tpl", {
    region     = var.region
    ssm_prefix = var.ssm_prefix
    data_vol   = replace(aws_ebs_volume.data.id, "-", "")
    deploy_sh  = base64encode(file("${path.module}/files/deploy.sh"))
  })

  tags = { Name = var.name, Backup = "impex" }

  lifecycle {
    # A newer AMI or an edited bootstrap script must never replace the server (and its disk attachment) by accident: deploys happen through SSM.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.this.id
}

resource "aws_eip_association" "this" {
  instance_id   = aws_instance.this.id
  allocation_id = var.eip_allocation_id
}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------
# Daily snapshots of the data disk
# ---------------------------------------------------------------------------------------------------------------------------------------------------------
data "aws_iam_policy_document" "assume_dlm" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${var.name}-snapshots"
  assume_role_policy = data.aws_iam_policy_document.assume_dlm.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "data" {
  description        = "Daily snapshots of the Impex data disk"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Backup = "impex" }

    schedule {
      name = "daily"
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }
      retain_rule {
        count = var.snapshot_retention_days
      }
      copy_tags = true
    }
  }
}
