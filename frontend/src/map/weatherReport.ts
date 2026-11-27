import type { TwoDayWeatherReportResponse } from "../api/client";

export type WeatherHour = Extract<TwoDayWeatherReportResponse, { status: "ready" }>["hourly_forecast"][number];

export function summarizeHourly(hours: WeatherHour[]) {
  const temperatures = hours.map((hour) => hour.air_temperature_c);
  const feelsLike = hours.map((hour) => hour.feels_like_c);
  return {
    low: Math.min(...temperatures),
    high: Math.max(...temperatures),
    feelsLow: Math.min(...feelsLike),
    feelsHigh: Math.max(...feelsLike),
    rain: hours.reduce((total, hour) => total + hour.precipitation_mm, 0),
    humidity: hours.reduce((total, hour) => total + hour.relative_humidity_pct, 0) / hours.length,
    firstWet: hours.find((hour) => hour.precipitation_mm > 0),
    peak: hours.reduce<WeatherHour | undefined>((wettest, hour) =>
      !wettest || hour.precipitation_mm > wettest.precipitation_mm ? hour : wettest, undefined),
  };
}
