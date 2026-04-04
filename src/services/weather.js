import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.OPENWEATHER_API_KEY;
const DEFAULT_CITY = process.env.WEATHER_CITY || "Buenos Aires";
const BASE_URL = "https://api.openweathermap.org/data/2.5";

export async function getCurrentWeather(city) {
  city = city || DEFAULT_CITY;
  const { data } = await axios.get(`${BASE_URL}/weather`, {
    params: { q: `${city},AR`, appid: API_KEY, units: "metric", lang: "es" }
  });

  return {
    city: data.name,
    temp: Math.round(data.main.temp),
    feels_like: Math.round(data.main.feels_like),
    humidity: data.main.humidity,
    description: data.weather[0].description,
    wind: Math.round(data.wind.speed * 3.6), // m/s to km/h
    icon: weatherIcon(data.weather[0].id)
  };
}

export async function getForecast(city, days = 3) {
  city = city || DEFAULT_CITY;
  const { data } = await axios.get(`${BASE_URL}/forecast`, {
    params: { q: `${city},AR`, appid: API_KEY, units: "metric", lang: "es" }
  });

  // Group by day
  const dailyMap = {};
  for (const item of data.list) {
    const date = item.dt_txt.split(" ")[0];
    if (!dailyMap[date]) {
      dailyMap[date] = { temps: [], descriptions: [], rain: 0, wind: [], ids: [] };
    }
    dailyMap[date].temps.push(item.main.temp);
    dailyMap[date].descriptions.push(item.weather[0].description);
    dailyMap[date].ids.push(item.weather[0].id);
    dailyMap[date].rain += (item.rain?.["3h"] || 0);
    dailyMap[date].wind.push(item.wind.speed);
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const forecast = [];

  for (const [date, info] of Object.entries(dailyMap)) {
    if (date === today) continue; // skip today (use current weather)
    if (forecast.length >= days) break;

    const minTemp = Math.round(Math.min(...info.temps));
    const maxTemp = Math.round(Math.max(...info.temps));
    const maxWind = Math.round(Math.max(...info.wind) * 3.6);
    const mainId = mostFrequent(info.ids);

    forecast.push({
      date,
      dayName: dayNameES(date),
      minTemp,
      maxTemp,
      rain: Math.round(info.rain * 10) / 10,
      wind: maxWind,
      description: mostFrequent(info.descriptions),
      icon: weatherIcon(mainId)
    });
  }

  return { city: data.city.name, forecast };
}

function mostFrequent(arr) {
  const freq = {};
  let maxCount = 0, maxVal = arr[0];
  for (const v of arr) {
    freq[v] = (freq[v] || 0) + 1;
    if (freq[v] > maxCount) { maxCount = freq[v]; maxVal = v; }
  }
  return maxVal;
}

function weatherIcon(id) {
  if (id >= 200 && id < 300) return "⛈️";
  if (id >= 300 && id < 400) return "🌧️";
  if (id >= 500 && id < 600) return "🌧️";
  if (id >= 600 && id < 700) return "❄️";
  if (id >= 700 && id < 800) return "🌫️";
  if (id === 800) return "☀️";
  if (id > 800) return "⛅";
  return "🌤️";
}

function dayNameES(dateStr) {
  const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const d = new Date(dateStr + "T12:00:00");
  return days[d.getDay()];
}

export function formatCurrentWeather(w) {
  return `${w.icon} *Clima en ${w.city}*\n\n🌡️ ${w.temp}°C (ST ${w.feels_like}°C)\n💧 Humedad: ${w.humidity}%\n💨 Viento: ${w.wind} km/h\n${w.description.charAt(0).toUpperCase() + w.description.slice(1)}`;
}

export function formatForecast(data) {
  let msg = `${data.forecast[0]?.icon || "🌤️"} *Pronóstico ${data.city}*\n`;
  for (const day of data.forecast) {
    msg += `\n*${day.dayName}*: ${day.icon} ${day.minTemp}°/${day.maxTemp}°`;
    if (day.rain > 0) msg += ` 🌧️ ${day.rain}mm`;
    msg += ` 💨${day.wind}km/h`;
  }
  return msg;
}

export function checkRainAlert(data) {
  const tomorrow = data.forecast[0];
  if (!tomorrow) return null;
  if (tomorrow.rain >= 10) {
    return `🌧️ *Alerta:* Se esperan lluvias fuertes mañana (${tomorrow.dayName}) — ${tomorrow.rain}mm estimados.`;
  }
  return null;
}
