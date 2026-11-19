import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import AdminApp from "./AdminApp";
import { adminBase } from "./api/adminPath";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><BrowserRouter basename={adminBase()}><AdminApp /></BrowserRouter></React.StrictMode>
);
