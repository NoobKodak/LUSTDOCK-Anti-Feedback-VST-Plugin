import { useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";

import { DemoStrip, Header } from "@/components/Chrome";
import { Admin } from "@/pages/Admin";
import { Checkout } from "@/pages/Checkout";
import { Landing } from "@/pages/Landing";
import { Orders } from "@/pages/Orders";
import { Plugins } from "@/pages/Plugins";
import { ProductPage } from "@/pages/ProductPage";
import { SoundProvider } from "@/lib/sound";
import { fetchProducts, type Product } from "@/lib/supabase";

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    fetchProducts()
      .then(setProducts)
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    if (!location.hash) window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);

  /*  The back office is not a page of the shop.

      It has its own dark palette and its own navigation, and sitting it under the store's
      yellow demo strip and centred logo made it look like a page that had lost its
      styling. Hiding the shop chrome here also lets the admin own the full height, which
      is what the sidebar needs to run down.                                            */
  const isBackOffice = location.pathname.startsWith("/admin");

  return (
    <SoundProvider>
      {!isBackOffice && <DemoStrip />}
      {!isBackOffice && <Header />}

      {loadError && (
        <div className="mx-auto w-full max-w-[1400px] px-6 pt-6 sm:px-10">
          <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Could not reach the store database: {loadError}
          </p>
        </div>
      )}

      <main>
        <Routes>
          <Route path="/" element={<Landing products={products} />} />
          <Route path="/plugins" element={<Plugins products={products} />} />
          <Route path="/plugins/:slug" element={<ProductPage />} />
          <Route path="/checkout/:slug" element={<Checkout products={products} />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/admin" element={<Admin />} />
          <Route
            path="*"
            element={
              <div className="mx-auto max-w-[1400px] px-6 py-24 sm:px-10">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">404</p>
                <h1 className="mt-3 text-3xl font-bold">Nothing here.</h1>
              </div>
            }
          />
        </Routes>
      </main>
    </SoundProvider>
  );
}
