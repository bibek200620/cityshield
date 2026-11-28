import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "maplibre-gl/dist/maplibre-gl.css";
import "./index.css";
import "./weather.css";

const Atlas = lazy(() => import("./App"));
const LandingPage = lazy(() => import("./landing/LandingPage"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Suspense>
        <Routes>
          <Route path="/" element={<Atlas />} />
          <Route path="/welcome" element={<LandingPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);
