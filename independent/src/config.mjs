export const FREE_MODELS = Object.freeze([
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-3.8-live",
]);
export const VOICES = Object.freeze(["Aoede", "Kore", "Puck"]);

function seconds(value, fallback, min, max, name, missing) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    missing.push(`${name} (integer ${min}–${max})`);
    return fallback;
  }
  return parsed;
}

export function readConfig(env = process.env) {
  const missing = [];
  const required = (name, ...aliases) => {
    const value = [name, ...aliases].map(key => env[key]?.trim()).find(Boolean) || "";
    if (!value || value.includes("your-project")) missing.push(name);
    return value;
  };
  const config = {
    supabaseUrl: required("SUPABASE_URL").replace(/\/$/, ""),
    supabaseAnonKey: required("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: required("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "Supabase_Secret_Key"),
    ownerEmail: required("OWNER_EMAIL").toLowerCase(),
    appOrigin: required("APP_ORIGIN").replace(/\/$/, ""),
    geminiApiKey: required("GEMINI_API_KEY", "Gemini_Key"),
    model: env.GEMINI_MODEL?.trim() || FREE_MODELS[0],
    appName: (env.APP_NAME?.trim() || "Cardputer Voice").slice(0, 60),
  };
  if (config.supabaseUrl) {
    try {
      if (new URL(config.supabaseUrl).protocol !== "https:") throw new Error();
    } catch { missing.push("SUPABASE_URL (HTTPS URL)"); }
  }
  if (config.appOrigin) {
    try {
      const origin = new URL(config.appOrigin);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
      if (origin.origin !== config.appOrigin ||
          (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))) {
        throw new Error();
      }
    } catch { missing.push("APP_ORIGIN (HTTPS origin, or HTTP localhost)"); }
  }
  if (config.ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.ownerEmail)) {
    missing.push("OWNER_EMAIL (email address)");
  }
  if (!FREE_MODELS.includes(config.model)) missing.push("GEMINI_MODEL (supported free-tier voice model)");
  config.dailyVoiceSeconds = seconds(env.DAILY_VOICE_SECONDS, 600, 60, 1800, "DAILY_VOICE_SECONDS", missing);
  config.sessionSeconds = seconds(env.SESSION_SECONDS, 240, 20, 240, "SESSION_SECONDS", missing);
  config.missing = [...new Set(missing)];
  config.configured = config.missing.length === 0;
  return Object.freeze(config);
}

export function publicConfig(config) {
  return {
    appName: config.appName,
    configured: config.configured,
    missing: config.missing,
    sessionSeconds: config.sessionSeconds,
    dailyVoiceSeconds: config.dailyVoiceSeconds,
    voices: VOICES,
  };
}
