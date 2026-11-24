# عقد البيانات المشترك بين النموذج وKotlin

هذا الملف يحدد شكل البيانات الذي يجب أن يبقى ثابتًا عند نقل منصة الري إلى تطبيق Android. HTML وPython وKotlin تطبيقات مختلفة للعقد نفسه وليست مصادر حساب مستقلة.

## سجل الطقس الموحد

```json
{
  "date": "2026-11-24",
  "location": {
    "name": "دمشق",
    "latitude": 33.5138,
    "longitude": 36.2765,
    "elevation_m": 1072.05
  },
  "weather": {
    "tmin_c": 10.6,
    "tmax_c": 24.5,
    "dew_point_c": 4.8,
    "relative_humidity_pct": null,
    "solar_radiation_mj_m2_day": 13.44,
    "wind_speed_10m_m_s": 2.00,
    "wind_speed_2m_m_s": 1.50,
    "surface_pressure_kpa": 89.5,
    "precipitation_mm": 0.0
  },
  "calculation": {
    "et0_mm_day": 2.675,
    "kc": 0.4,
    "etc_mm_day": 1.07,
    "stage": "L1"
  },
  "provenance": {
    "primary_source": "Open-Meteo",
    "solar_source": "Open-Meteo",
    "status": "forecast",
    "retrieved_at": "2026-11-24T17:30:00Z",
    "quality": "complete",
    "notes": "Forecast; wind requested in m/s and converted from 10m to 2m."
  }
}
```

## الوحدات الإلزامية

| الحقل | الوحدة | الملاحظة |
|---|---|---|
| `tmin_c`, `tmax_c`, `dew_point_c` | °C | درجات مئوية |
| `solar_radiation_mj_m2_day` | MJ/m²/day | NASA POWER مع `community=AG` لا يحتاج `×3.6` |
| `wind_speed_10m_m_s`, `wind_speed_2m_m_s` | m/s | Open-Meteo يطلب صراحة `wind_speed_unit=ms` |
| `surface_pressure_kpa` | kPa | تحويل hPa إلى kPa إذا لزم |
| `precipitation_mm` | mm/day | المطر اليومي |
| `et0_mm_day`, `etc_mm_day` | mm/day | قيم موجبة أو `null` عند نقص البيانات |
| `kc` | بلا وحدة | معامل المحصول المحلي |

## حالات السجل

- `actual`: بيانات يومية فعلية مكتملة من المصدر الأساسي.
- `alternative`: بيانات فعلية/ماضية من مصدر بديل أو سجل مدمج عوّض متغيرًا ناقصًا.
- `forecast`: بيانات مستقبلية من توقع الطقس، ولا تعرض كقياس.
- `incomplete`: متغير أساسي مفقود؛ لا تُنتج قيمة ET0 مصطنعة.

## قواعد اختيار المصدر

1. يستخدم NASA POWER أولًا عندما تتوفر الحرارة، الندى أو الرطوبة، الرياح، والإشعاع.
2. إذا نقص إشعاع NASA، يعوض Open-Meteo الإشعاع فقط إن أمكن، ويُوسم السجل `alternative` مع حفظ المصدرين.
3. تستخدم Open-Meteo للتوقعات المستقبلية، وتوسم السجلات `forecast` حتى لو توفر NASA لتاريخ سابق.
4. عند عدم كفاية المتغيرات، يحفظ التطبيق السجل مع `status=incomplete` ويعرض سبب النقص.
5. يبقى الارتفاع جزءًا من إعداد الموقع، ولا يبدله التطبيق تلقائيًا بسبب اختلاف الارتفاع الذي تعيده خدمة الطقس.

## قاعدة Kc

يستقبل المحرك `crop_id`, `season_start`, و`target_date`. عدد الأيام من البداية صفري في يوم الزراعة. بعد ذلك يطبق:

- `L1`: `Kc_ini` ثابت.
- `L2`: انتقال خطي من `Kc_ini` إلى `Kc_mid`، بنسبة `(day + 1) / L2`.
- `L3`: `Kc_mid` ثابت.
- `L4`: انتقال خطي من `Kc_mid` إلى `Kc_end`، بنسبة `(day + 1) / L4`.
- بعد نهاية `L4`: تثبيت `Kc_end` مؤقتًا.
- قبل بداية الموسم: `kc=null` و`stage=before_season`.

## موضع العقد في Kotlin

يمكن تمثيل هذا العقد بواسطة `@Serializable data class` في طبقة `domain.model`. لا تضع كائنات استجابة NASA أو Open-Meteo مباشرة في Compose؛ يجب أن تمر أولًا عبر محول مصدر إلى `WeatherRecord`. وتبقى معادلات FAO-56 في `domain.calculation`, بينما تحفظ Room السجل الموحد ونتائج الحساب وبيانات المصدر.
