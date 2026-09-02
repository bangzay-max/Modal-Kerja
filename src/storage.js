import { supabase } from "./supabaseClient";

// Backend penyimpanan: tabel key-value di Supabase (lihat supabase/schema.sql
// untuk skema tabelnya). Interface (get/set/list/delete) sengaja dibikin
// identik dengan window.storage di sandbox Claude, jadi App.jsx tidak perlu
// diubah sama sekali — cuma modul ini yang beda isi implementasinya.

const PREFIX = "mk-storage:";

function fullKey(key, shared) {
  return PREFIX + (shared ? "shared:" : "local:") + key;
}

export const storage = {
  async get(key, shared = false) {
    const { data, error } = await supabase
      .from("mk_storage")
      .select("value")
      .eq("key", fullKey(key, shared))
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("key not found: " + key);
    return { key, value: data.value, shared };
  },

  async set(key, value, shared = false) {
    const { error } = await supabase.from("mk_storage").upsert(
      {
        key: fullKey(key, shared),
        value,
        shared,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );
    if (error) throw error;
    return { key, value, shared };
  },

  async delete(key, shared = false) {
    const { error } = await supabase.from("mk_storage").delete().eq("key", fullKey(key, shared));
    if (error) throw error;
    return { key, deleted: true, shared };
  },

  async list(prefix = "", shared = false) {
    const full = fullKey(prefix, shared);
    const base = fullKey("", shared);
    const { data, error } = await supabase
      .from("mk_storage")
      .select("key")
      .like("key", full + "%");
    if (error) throw error;
    const keys = (data || []).map((row) => row.key.slice(base.length));
    return { keys, prefix, shared };
  },
};
