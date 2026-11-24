# ملاحظات العمل — CWR / DIN

## هدف المنتج المعتمد

المنتج النهائي المستهدف هو تطبيق Android بصيغة APK بلغة Kotlin باسم **منصة الري وجدولة الري للمحاصيل والأشجار المثمرة**. نسخة HTML الحالية نموذج تحقق ومناقشة فقط؛ يجب أن تبقى الحسابات وعقود البيانات مستقلة عن المتصفح وقابلة للنقل إلى Kotlin.

## 2026-11-24 — التاريخ المرجعي

كان حقل `بداية الموسم` يغير عمر المحصول و`Kc` فقط، بينما تبقى فترة الطقس حول تاريخ اليوم الحالي. أضيف حقل مستقل باسم `تاريخ الطقس المرجعي`؛ عند اختيار تاريخ قديم تستخدم المنصة NASA POWER وOpen-Meteo Archive للفترة التاريخية نفسها، ولا تعرض بيانات العام الحالي على أنها نتيجة للعام السابق.

## 2026-11-24 — NASA POWER

- حزمة `syria-irrigation-platform-v0.6` تحتوي أصلًا على تصحيح وحدة الإشعاع الشمسي في `tools/nasa_power_sync.py`.
- عند استخدام NASA POWER مع `community=AG`، تكون `ALLSKY_SFC_SW_DWN` بوحدة `MJ/m^2/day`، لذلك لا يجوز ضربها في `3.6`.
- التحويل `×3.6` يطبق فقط إذا أعاد المصدر الوحدة بصيغة `kW`/`kWh` المناسبة.
- تحققت من أن كود المشروع يستخدم تحويلًا مشروطًا بالوحدة، واستخدمت هذا السلوك في الحسابات.
- لم أعدّل ملف NASA الأصلي في مستودع GitHub بعد؛ الموجود حاليًا تصحيح الحزمة الأصلية، مع توثيق ومراجعة.

## 2026-11-24 — دمشق والقمح

- الإحداثيات المستخدمة: `33.5138, 36.2765`.
- ارتفاع NASA POWER المستخدم للاتساق: `1072.05 m`.
- بداية موسم القمح المؤقتة: `15/11/2026`.
- قيم الملحق المحلي: `Kc_ini=0.40`, `Kc_mid=1.06`, `Kc_end=0.82`, `L1=15`, `L2=30`, `L3=35`, `L4=100`.
- `ETc = ET0 × Kc`.
- NASA POWER أعاد إشعاعًا مكتملًا حتى 16/11 فقط ضمن الطلب السابق.
- Open-Meteo استُخدم بديلًا للفترة 17–23/11، وتوقعًا للفترة 24–30/11.
- سرعة الرياح اليومية في Open-Meteo واردة على 10m وحُوّلت إلى 2m وفق FAO-56.
- يطلب التطبيق صراحة `wind_speed_unit=ms` من Open-Meteo قبل تحويل سرعة 10m إلى 2m؛ هذا يمنع تفسير القيم الافتراضية بالكيلومتر/ساعة على أنها م/ث.
- Open-Meteo يعيد ارتفاعًا مختلفًا (693m)؛ لذلك أبقيت ارتفاع NASA في الحساب الموحد، ويجب مناقشة تثبيت ارتفاع الحقل لاحقًا.

## مصادر خارجية

- NASA POWER Daily API: https://power.larc.nasa.gov/api/temporal/daily/point
- طلب دمشق المستخدم: https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,T2MDEW,RH2M,ALLSKY_SFC_SW_DWN,WS2M,PS,PRECTOTCORR&community=AG&longitude=36.2765&latitude=33.5138&start=20261115&end=20261123&format=JSON&time-standard=LST
- Open-Meteo Forecast API: https://api.open-meteo.com/v1/forecast?latitude=33.5138&longitude=36.2765&timezone=Asia%2FDamascus&forecast_days=7&past_days=7&daily=temperature_2m_max,temperature_2m_min,dew_point_2m_mean,wind_speed_10m_mean,shortwave_radiation_sum,precipitation_sum
