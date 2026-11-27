import type { Metadata, Viewport } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import { THEME_COLOR } from "./design/tokens";
import "./globals.css";

export const metadata: Metadata = {
  title: "Пульс Москвы — что сейчас в городе",
  description:
    "Пульс Москвы — что сейчас в городе: погода и ветер, школы, транспорт, парки и жизнь районов по открытым данным.",
  manifest: "/puls-moskvy/manifest.json",
  icons: { icon: "/puls-moskvy/icon.svg" },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
};

// D3: тема до первого кадра React. Импортировать TS в инлайн-скрипт нельзя,
// поэтому здесь компактная копия NOAA-формулы из solar.ts / daylight.ts —
// только для антфлеша; основной расчёт в map.tsx перезапишет значение.
// Координаты и порог (высота Солнца ≤ 0° → dark) обязаны совпадать с
// MOSCOW_CENTER и themeForTime() из daylight.ts. `?theme=` сильнее времени.
const themeInit = `(function(){try{
var q=new URLSearchParams(location.search),o=q.get("theme");
if(o==="dark"||o==="light"){document.documentElement.dataset.theme=o;return}
var ms=Date.now(),jd=ms/864e5+2440587.5,T=(jd-2451545)/36525,R=Math.PI/180;
var L=((280.46646+T*(36000.76983+T*0.0003032))%360+360)%360,M=357.52911+T*(35999.05029-0.0001537*T),e=0.016708634-T*(0.000042037+0.0000001267*T),mr=M*R;
var C=Math.sin(mr)*(1.914602-T*(0.004817+0.000014*T))+Math.sin(2*mr)*(0.019993-0.000101*T)+Math.sin(3*mr)*0.000289;
var om=(125.04-1934.136*T)*R,lam=(L+C-0.00569-0.00478*Math.sin(om))*R;
var eps=(23+(26+(21.448-T*(46.815+T*(0.00059-T*0.001813)))/60)/60+0.00256*Math.cos(om))*R;
var y=Math.tan(eps/2)**2,l0=L*R,dec=Math.asin(Math.sin(eps)*Math.sin(lam));
var eot=4/R*(y*Math.sin(2*l0)-2*e*Math.sin(mr)+4*e*y*Math.sin(mr)*Math.cos(2*l0)-0.5*y*y*Math.sin(4*l0)-1.25*e*e*Math.sin(2*mr));
var ha=(((ms%864e5)/6e4+eot+4*37.6173)/4-180)*R,lat=55.7558*R;
var alt=Math.asin(Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(ha));
document.documentElement.dataset.theme=alt<=0?"dark":"light";
}catch(e){}})();`;

// В dev (localhost) SW не регистрируем — кэширование чанков ломает HMR.
const swRegister = `if ("serviceWorker" in navigator && !["localhost","127.0.0.1"].includes(location.hostname)) { navigator.serviceWorker.register("/puls-moskvy/sw.js"); }`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className="h-full">
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInit }}
        />
        <Script
          id="sw-register"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{ __html: swRegister }}
        />
        {children}
      </body>
    </html>
  );
}
