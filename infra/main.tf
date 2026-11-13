# Chat harness PoC: Azure resources owned by this app. Lives next to the agent-platform-poc
# platform (same AKS cluster and storage account, referenced as data sources).
#   - Blob container for conversation workspaces (uploads/, outputs/)
#   - Workload identity for chat-api (Entra ID token, no keys) scoped to that container
# The 30-day lifecycle rule is account-wide, so it lives with the account owner
# (agent-platform-poc infra/platform/storage.tf).
terraform {
  required_version = ">= 1.13.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.13"
    }
  }
  # Same state account as the platform, separate key.
  backend "azurerm" {
    resource_group_name  = "tfstate"
    storage_account_name = "tfstate15184"
    container_name       = "agent-platform-poc"
    key                  = "chat-harness.tfstate"
    use_azuread_auth     = true
  }
}

provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}

variable "subscription_id" {
  type = string
}

variable "resource_group_name" {
  type    = string
  default = "aks-lab"
}

variable "cluster_name" {
  type    = string
  default = "aks-lab"
}

variable "storage_account_name" {
  description = "Platform artifacts account (shared keys disabled, AKS egress IP allowlisted)."
  type        = string
  default     = "stagentpocjt75"
}

variable "namespace" {
  type    = string
  default = "chat"
}

data "azurerm_kubernetes_cluster" "main" {
  name                = var.cluster_name
  resource_group_name = var.resource_group_name
}

data "azurerm_storage_account" "artifacts" {
  name                = var.storage_account_name
  resource_group_name = var.resource_group_name
}

# Management-plane create (ARM), so the account's network rules do not block the laptop.
resource "azurerm_storage_container" "workspaces" {
  name                  = "chat-workspaces"
  storage_account_id    = data.azurerm_storage_account.artifacts.id
  container_access_type = "private"
}

resource "azurerm_user_assigned_identity" "chat_api" {
  name                = "id-${var.cluster_name}-chat-api"
  location            = data.azurerm_kubernetes_cluster.main.location
  resource_group_name = var.resource_group_name
  tags                = { project = "chat-harness-poc" }
}

resource "azurerm_federated_identity_credential" "chat_api" {
  name                      = "chat-api"
  user_assigned_identity_id = azurerm_user_assigned_identity.chat_api.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = data.azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject                   = "system:serviceaccount:${var.namespace}:chat-api"
}

# Container scope only: chat-api cannot read the agents' containers in the same account.
resource "azurerm_role_assignment" "chat_api_blob" {
  scope                = azurerm_storage_container.workspaces.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.chat_api.principal_id
}

# Read-only access for the operator in the portal Storage Browser (shared keys are disabled,
# and Owner is control plane only). Empty variable = no assignment.
variable "operator_object_id" {
  type    = string
  default = ""
}

resource "azurerm_role_assignment" "operator_blob_reader" {
  count                = var.operator_object_id == "" ? 0 : 1
  scope                = azurerm_storage_container.workspaces.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = var.operator_object_id
}

output "chat_api_client_id" {
  value = azurerm_user_assigned_identity.chat_api.client_id
}

output "blob_account_url" {
  value = data.azurerm_storage_account.artifacts.primary_blob_endpoint
}
