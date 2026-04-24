import dotenv from 'dotenv'

dotenv.config()

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export const config = {
  telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
  aiBackendUrl: requireEnv('AI_BACKEND_URL').replace(/\/$/, ''),
  webAppBaseUrl: requireEnv('WEB_APP_BASE_URL').replace(/\/$/, ''),
  publicWebAppBaseUrl: (
    process.env.PUBLIC_WEB_APP_BASE_URL || process.env.WEB_APP_BASE_URL
  ).replace(/\/$/, ''),
  nodeEnv: process.env.NODE_ENV || 'development'
}