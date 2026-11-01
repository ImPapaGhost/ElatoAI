#pragma once

// Copy to PersonalConfig.h after your independent server is deployed.
// PersonalConfig.h is ignored by Git. This personal build embeds a revocable
// device credential; do not publish the compiled personal .bin.
#define CARDPUTER_SERVER_HOST "your-app.vercel.app"
#define CARDPUTER_DEVICE_TOKEN "REPLACE_WITH_RANDOM_DEVICE_TOKEN_FROM_YOUR_DASHBOARD"

// Paste the trusted CA certificate for your deployed HTTPS/WSS host here.
// Use a CA PEM, not a leaf certificate. TLS verification stays enabled.
static const char CARDPUTER_SERVER_CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
REPLACE_WITH_THE_CA_CERTIFICATE_FOR_YOUR_DEPLOYMENT
-----END CERTIFICATE-----
)PEM";
