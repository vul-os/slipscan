<script lang="ts">
  /**
   * Catalogue — categories group products, products group variants (Phase
   * 6.3a).
   *
   * **The variant is the unit that matters, and this screen is built around
   * saying so.** A product ("T-shirt") is a name and a category; nothing
   * stocks or sells against it. Every SKU, price, cost price and reorder
   * point — the things stock movements and every order line actually
   * reference — live one level down, on the variant. So a product row here
   * opens to its variants rather than hiding them behind a second screen,
   * and a product with none is shown as exactly that: not yet sellable.
   *
   * Business-only (`BookProfile.show_catalogue`). A personal book refuses
   * the route itself, the same as Contacts, rather than relying only on the
   * sidebar hiding its own entry.
   *
   * NOT built: stock levels and on-hand — that is the Stock ledger's own
   * screen (ROADMAP.md 6.9), reading the same `variant_id` this screen
   * creates, and duplicating it here would be a second place for the two to
   * disagree. Also not built: an editor for `attributes` (the free-form JSON
   * blob core stores verbatim) and multi-currency variants — `currency` is
   * set once at creation from the book's own currency and cannot be changed
   * from here, matching `ProductVariantUpdateRequest`, which carries no
   * `currency` field at all.
   */
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import { router } from "../lib/state/router.svelte";
  import { minorToInput, parseMoneyInput } from "../lib/util/format";
  import type {
    Book,
    BookProfile,
    Product,
    ProductCategory,
    ProductVariant,
  } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import Dialog from "../lib/components/Dialog.svelte";
  import ConfirmDialog from "../lib/components/ConfirmDialog.svelte";

  let book = $state<Book | null>(null);
  let profile = $state<BookProfile | null>(null);
  let categories = $state<ProductCategory[]>([]);
  let products = $state<Product[]>([]);
  let variants = $state<ProductVariant[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load(background = false) {
    if (!background) loading = true;
    if (!background) loadError = null;
    try {
      const b = requireBook(await api.bookList());
      book = b;
      const p = await api.bookProfile({ book_id: b.id });
      profile = p;
      if (!p.show_catalogue) {
        categories = [];
        products = [];
        variants = [];
        return;
      }
      [categories, products, variants] = await Promise.all([
        api.productCategoryList({ book_id: b.id }),
        api.productList({ book_id: b.id }),
        api.productVariantListForBook({ book_id: b.id }),
      ]);
    } catch (err) {
      if (!background) loadError = String(err);
    } finally {
      loading = false;
    }
  }
  load();

  function variantsFor(productId: string): ProductVariant[] {
    return variants.filter((v) => v.product_id === productId);
  }

  function categoryName(id: string | null): string {
    if (id === null) return "Uncategorised";
    return categories.find((c) => c.id === id)?.name ?? "—";
  }

  // -- filtering --------------------------------------------------------------

  let categoryFilter = $state(""); // "" = all, "none" = uncategorised, else id
  let search = $state("");

  const filteredProducts = $derived(
    products.filter((p) => {
      if (categoryFilter === "none" && p.product_category_id !== null)
        return false;
      if (
        categoryFilter &&
        categoryFilter !== "none" &&
        p.product_category_id !== categoryFilter
      )
        return false;
      if (search) {
        const s = search.toLowerCase();
        const inName = p.name.toLowerCase().includes(s);
        const inVariant = variantsFor(p.id).some(
          (v) => v.sku.toLowerCase().includes(s) || v.name.toLowerCase().includes(s),
        );
        if (!inName && !inVariant) return false;
      }
      return true;
    }),
  );

  // -- expand / collapse --------------------------------------------------------

  let expanded = $state<string | null>(null);
  function toggle(p: Product) {
    expanded = expanded === p.id ? null : p.id;
  }

  // -------------------------------------------------------------------------
  // categories: add, rename, delete. Deleting one is `ON DELETE SET NULL` in
  // core — its products stay, moved to Uncategorised — never a cascade.
  // -------------------------------------------------------------------------

  let categoriesOpen = $state(false);
  let newCategoryName = $state("");
  let categoryBusy = $state(false);
  let categoryError = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");

  async function addCategory() {
    if (!book) return;
    const name = newCategoryName.trim();
    if (!name) return;
    categoryBusy = true;
    categoryError = null;
    try {
      await api.productCategoryCreate({ book_id: book.id, name });
      newCategoryName = "";
      await load(true);
    } catch (err) {
      categoryError = String(err);
    } finally {
      categoryBusy = false;
    }
  }

  function startRename(c: ProductCategory) {
    renamingId = c.id;
    renameValue = c.name;
    categoryError = null;
  }

  async function commitRename(c: ProductCategory) {
    const name = renameValue.trim();
    if (!name) return;
    categoryBusy = true;
    categoryError = null;
    try {
      await api.productCategoryRename({ id: c.id, name });
      renamingId = null;
      await load(true);
    } catch (err) {
      categoryError = String(err);
    } finally {
      categoryBusy = false;
    }
  }

  let confirmDeleteCategory = $state<ProductCategory | null>(null);
  let deleteCategoryBusy = $state(false);

  function askDeleteCategory(c: ProductCategory) {
    // Close the list dialog first: Dialog is a single modal primitive with
    // its own focus trap, and two open at once would fight over both focus
    // and Escape. The confirm stands alone; "Categories" reopens the list.
    categoriesOpen = false;
    confirmDeleteCategory = c;
    categoryError = null;
  }

  async function commitDeleteCategory() {
    if (!confirmDeleteCategory) return;
    const gone = confirmDeleteCategory;
    deleteCategoryBusy = true;
    categoryError = null;
    try {
      await api.productCategoryDelete({ id: gone.id });
      if (categoryFilter === gone.id) categoryFilter = "";
      confirmDeleteCategory = null;
      await load(true);
    } catch (err) {
      categoryError = String(err);
    } finally {
      deleteCategoryBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // products: create / edit
  // -------------------------------------------------------------------------

  let productFormOpen = $state(false);
  let editingProductId = $state<string | null>(null);
  let pfName = $state("");
  let pfCategory = $state("");
  let pfDescription = $state("");
  let pfBusy = $state(false);
  let pfError = $state<string | null>(null);

  function openCreateProduct() {
    editingProductId = null;
    pfName = "";
    pfCategory = categoryFilter && categoryFilter !== "none" ? categoryFilter : "";
    pfDescription = "";
    pfError = null;
    productFormOpen = true;
  }

  function openEditProduct(p: Product) {
    editingProductId = p.id;
    pfName = p.name;
    pfCategory = p.product_category_id ?? "";
    pfDescription = p.description ?? "";
    pfError = null;
    productFormOpen = true;
  }

  async function submitProduct() {
    if (!book) return;
    const name = pfName.trim();
    if (!name) {
      pfError = "Name the product to save it.";
      return;
    }
    pfBusy = true;
    pfError = null;
    try {
      if (editingProductId) {
        await api.productUpdate({
          id: editingProductId,
          name,
          description: pfDescription.trim() || null,
          product_category_id: pfCategory || null,
        });
      } else {
        await api.productCreate({
          book_id: book.id,
          name,
          description: pfDescription.trim() || undefined,
          product_category_id: pfCategory || undefined,
        });
      }
      productFormOpen = false;
      await load(true);
    } catch (err) {
      pfError = String(err);
    } finally {
      pfBusy = false;
    }
  }

  // -- products: delete. Core cascades to untraded variants, but refuses
  // outright the moment any one of them has a stock movement or order line.

  let confirmDeleteProduct = $state<Product | null>(null);
  let deleteProductBusy = $state(false);
  let deleteProductError = $state<string | null>(null);

  function askDeleteProduct(p: Product) {
    confirmDeleteProduct = p;
    deleteProductError = null;
  }

  const deleteProductBody = $derived.by(() => {
    if (!confirmDeleteProduct) return "";
    const n = variantsFor(confirmDeleteProduct.id).length;
    if (n === 0) return "This product has no variants. Deleting it removes just the product.";
    return `This also deletes its ${n} ${n === 1 ? "variant" : "variants"} — unless one of them has ever been traded, in which case the whole delete is refused and nothing changes.`;
  });

  async function commitDeleteProduct() {
    if (!confirmDeleteProduct) return;
    deleteProductBusy = true;
    deleteProductError = null;
    try {
      await api.productDelete({ id: confirmDeleteProduct.id });
      if (expanded === confirmDeleteProduct.id) expanded = null;
      confirmDeleteProduct = null;
      await load(true);
    } catch (err) {
      const msg = String(err);
      deleteProductError = msg.includes("cannot be deleted")
        ? "One of its variants has stock movements or order lines against it, so nothing here can be deleted — that is trade history."
        : msg;
    } finally {
      deleteProductBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // variants: add / edit, inline under the product they belong to
  // -------------------------------------------------------------------------

  let variantFormFor = $state<string | null>(null); // product id
  let editingVariantId = $state<string | null>(null);
  let vfSku = $state("");
  let vfName = $state("");
  let vfPrice = $state("");
  let vfCost = $state("");
  let vfReorder = $state("0");
  let vfBusy = $state(false);
  let vfError = $state<string | null>(null);

  function openAddVariant(productId: string) {
    variantFormFor = productId;
    editingVariantId = null;
    vfSku = "";
    vfName = "";
    vfPrice = "";
    vfCost = "";
    vfReorder = "0";
    vfError = null;
  }

  function openEditVariant(v: ProductVariant) {
    variantFormFor = v.product_id;
    editingVariantId = v.id;
    vfSku = v.sku;
    vfName = v.name;
    vfPrice = minorToInput(v.price_minor, v.currency);
    vfCost = minorToInput(v.cost_price_minor, v.currency);
    vfReorder = String(v.reorder_point);
    vfError = null;
  }

  function closeVariantForm() {
    variantFormFor = null;
    editingVariantId = null;
  }

  async function submitVariant(productId: string) {
    if (!book) return;
    const sku = vfSku.trim();
    const name = vfName.trim();
    if (!sku || !name) {
      vfError = "Give the variant a SKU and a name.";
      return;
    }
    const currency = book.currency;
    const price = vfPrice.trim() === "" ? 0 : parseMoneyInput(vfPrice, currency);
    if (price === null) {
      vfError = "Enter a valid price.";
      return;
    }
    const cost = vfCost.trim() === "" ? 0 : parseMoneyInput(vfCost, currency);
    if (cost === null) {
      vfError = "Enter a valid cost price.";
      return;
    }
    const reorder = vfReorder.trim() === "" ? 0 : Number(vfReorder.trim());
    if (!Number.isInteger(reorder) || reorder < 0) {
      vfError = "Reorder point must be a whole number, zero or more.";
      return;
    }
    vfBusy = true;
    vfError = null;
    try {
      if (editingVariantId) {
        await api.productVariantUpdate({
          id: editingVariantId,
          sku,
          name,
          price_minor: price,
          cost_price_minor: cost,
          reorder_point: reorder,
        });
      } else {
        await api.productVariantAdd({
          product_id: productId,
          sku,
          name,
          price_minor: price,
          cost_price_minor: cost,
          currency,
          reorder_point: reorder,
        });
      }
      closeVariantForm();
      await load(true);
    } catch (err) {
      vfError = String(err);
    } finally {
      vfBusy = false;
    }
  }

  // -- variants: delete. Core refuses (ON DELETE RESTRICT) once a stock
  // movement or order line names it — the same rule the product cascade
  // above checks per-variant.

  let confirmDeleteVariant = $state<ProductVariant | null>(null);
  let deleteVariantBusy = $state(false);
  let deleteVariantError = $state<string | null>(null);

  function askDeleteVariant(v: ProductVariant) {
    confirmDeleteVariant = v;
    deleteVariantError = null;
  }

  async function commitDeleteVariant() {
    if (!confirmDeleteVariant) return;
    deleteVariantBusy = true;
    deleteVariantError = null;
    try {
      await api.productVariantDelete({ id: confirmDeleteVariant.id });
      confirmDeleteVariant = null;
      await load(true);
    } catch (err) {
      const msg = String(err);
      deleteVariantError = msg.includes("cannot be deleted")
        ? "This variant has stock movements or order lines against it, so it cannot be deleted — that is trade history, not this screen's to erase."
        : msg;
    } finally {
      deleteVariantBusy = false;
    }
  }
</script>

<PageHeader
  title="Catalogue"
  subtitle="Products group variants — the SKU, price, cost price and reorder point that stock and every order line actually reference live on the variant, one level down."
>
  {#snippet actions()}
    {#if profile?.show_catalogue}
      <button class="btn" onclick={() => (categoriesOpen = true)}>
        <Icon name="folder" size={14} />
        Categories
      </button>
      <button class="btn btn-primary" onclick={openCreateProduct}>
        <Icon name="plus" size={14} />
        New product
      </button>
    {/if}
  {/snippet}
</PageHeader>

{#if loading}
  <div class="card"><Skeleton rows={6} /></div>
{:else if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load the catalogue" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if !profile?.show_catalogue}
  <!-- Route refusal: reached directly (hash, palette) rather than through a
       sidebar that already hid this entry. -->
  <div class="card">
    <EmptyState
      icon="bank"
      title="Catalogue is for business books"
      body="{book?.name ?? 'This book'} is a personal book, so there is nothing to sell or stock. Switch it to Business in Settings › General to turn this on; nothing here is deleted either way."
    >
      {#snippet actions()}
        <button class="btn btn-primary" onclick={() => router.go("settings")}>
          Open Settings
        </button>
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <select class="input w-full sm:w-52" bind:value={categoryFilter} aria-label="Category">
      <option value="">All categories</option>
      <option value="none">Uncategorised</option>
      {#each categories as c (c.id)}
        <option value={c.id}>{c.name}</option>
      {/each}
    </select>
    <div class="relative w-full sm:w-64">
      <Icon
        name="search"
        size={14}
        class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-t3"
      />
      <input
        class="input pl-8"
        placeholder="Filter by product, SKU or variant…"
        bind:value={search}
      />
    </div>
    <span class="ml-auto text-[11.5px] text-t3">
      <span class="num">{variants.length}</span>
      {variants.length === 1 ? "variant" : "variants"} across
      <span class="num">{products.length}</span>
      {products.length === 1 ? "product" : "products"}
    </span>
  </div>

  <div class="card divide-y divide-line overflow-hidden">
    {#if products.length === 0}
      <EmptyState
        icon="catalogue"
        title="No products yet"
        body="Add a product, then give it at least one variant — the SKU, price and reorder point stock and every order line actually reference. A product with no variants is not yet sellable."
      >
        {#snippet actions()}
          <button class="btn btn-primary" onclick={openCreateProduct}>
            <Icon name="plus" size={14} />
            Add your first product
          </button>
        {/snippet}
      </EmptyState>
    {:else if filteredProducts.length === 0}
      <EmptyState
        icon="search"
        title="Nothing matches"
        body="Try a broader search or a different category, or clear both to see all {products.length} products."
      >
        {#snippet actions()}
          <button
            class="btn"
            onclick={() => {
              search = "";
              categoryFilter = "";
            }}
          >
            Clear filters
          </button>
        {/snippet}
      </EmptyState>
    {:else}
      {#each filteredProducts as p (p.id)}
        {@const pVariants = variantsFor(p.id)}
        {@const open = expanded === p.id}
        <div>
          <div class="row-hover flex items-center gap-2 px-4 py-3">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-expanded={open}
              aria-controls="cat-variants-{p.id}"
              onclick={() => toggle(p)}
            >
              <Icon
                name={open ? "chevron-up" : "chevron-down"}
                size={12}
                class="shrink-0 text-t3"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px] font-medium">{p.name}</span>
                <span class="block truncate text-[11px] text-t3">
                  {categoryName(p.product_category_id)} ·
                  <span class="num">{pVariants.length}</span>
                  {pVariants.length === 1 ? "variant" : "variants"}
                  {#if pVariants.length === 0}
                    <span class="text-warning">· not sellable yet</span>
                  {/if}
                </span>
              </span>
            </button>
            <div class="flex shrink-0 items-center gap-1">
              <button
                class="btn btn-ghost h-7 w-7 px-0"
                aria-label="Edit {p.name}"
                onclick={() => openEditProduct(p)}
              >
                <Icon name="pencil" size={13} />
              </button>
              <button
                class="btn btn-ghost h-7 w-7 px-0 hover:text-danger"
                aria-label="Delete {p.name}"
                onclick={() => askDeleteProduct(p)}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
          {#if open}
            <div id="cat-variants-{p.id}" class="reveal">
              <div class="reveal-inner border-t border-line bg-sunken/40 px-4 py-3">
                {#if p.description}
                  <p class="mb-3 text-[12px] text-t2">{p.description}</p>
                {/if}

                {#if pVariants.length > 0}
                  <div class="table-wrap table-scroll mb-2 rounded-lg border border-line">
                    <table class="w-full text-[12px]">
                      <thead>
                        <tr>
                          <th class="th">SKU</th>
                          <th class="th">Variant</th>
                          <th class="th text-right">Price</th>
                          <th class="th text-right">Cost price</th>
                          <th class="th text-right">Reorder at</th>
                          <th class="th w-16"><span class="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each pVariants as v (v.id)}
                          <tr class="row-hover">
                            <td class="td num text-t2">{v.sku}</td>
                            <td class="td">{v.name}</td>
                            <td class="td text-right">
                              <Money amount={v.price_minor} currency={v.currency} />
                            </td>
                            <td class="td text-right text-t2">
                              <Money amount={v.cost_price_minor} currency={v.currency} />
                            </td>
                            <td class="td num text-right text-t2">{v.reorder_point}</td>
                            <td class="td">
                              <div class="flex items-center justify-end gap-1">
                                <button
                                  class="btn btn-ghost h-6 w-6 px-0"
                                  aria-label="Edit variant {v.name}"
                                  onclick={() => openEditVariant(v)}
                                >
                                  <Icon name="pencil" size={12} />
                                </button>
                                <button
                                  class="btn btn-ghost h-6 w-6 px-0 hover:text-danger"
                                  aria-label="Delete variant {v.name}"
                                  onclick={() => askDeleteVariant(v)}
                                >
                                  <Icon name="trash" size={12} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {:else if variantFormFor !== p.id}
                  <p class="mb-2 text-[12px] text-t3">
                    No variants yet — add the first one below to make {p.name} sellable.
                  </p>
                {/if}

                {#if variantFormFor === p.id}
                  <form
                    class="rounded-lg border border-line bg-panel p-3"
                    onsubmit={(e) => {
                      e.preventDefault();
                      submitVariant(p.id);
                    }}
                  >
                    <div class="flex flex-wrap items-end gap-2">
                      <label class="block w-32">
                        <span class="mb-1 block text-[11px] text-t2">SKU</span>
                        <input data-autofocus class="input h-8" bind:value={vfSku} autocomplete="off" />
                      </label>
                      <label class="block min-w-40 flex-1">
                        <span class="mb-1 block text-[11px] text-t2">Name</span>
                        <input class="input h-8" bind:value={vfName} autocomplete="off" />
                      </label>
                      <label class="block w-28">
                        <span class="mb-1 block text-[11px] text-t2">Price</span>
                        <input class="input h-8 text-right font-mono" inputmode="decimal" bind:value={vfPrice} />
                      </label>
                      <label class="block w-28">
                        <span class="mb-1 block text-[11px] text-t2">Cost price</span>
                        <input class="input h-8 text-right font-mono" inputmode="decimal" bind:value={vfCost} />
                      </label>
                      <label class="block w-24">
                        <span class="mb-1 block text-[11px] text-t2">Reorder at</span>
                        <input class="input h-8 text-right font-mono" inputmode="numeric" bind:value={vfReorder} />
                      </label>
                      <button class="btn btn-primary h-8" type="submit" disabled={vfBusy}>
                        {vfBusy ? "Saving…" : editingVariantId ? "Save variant" : "Add variant"}
                      </button>
                      <button class="btn btn-ghost h-8" type="button" onclick={closeVariantForm}>
                        Cancel
                      </button>
                    </div>
                    {#if vfError}
                      <p
                        class="mt-2 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
                        role="alert"
                      >
                        <Icon name="alert-circle" size={13} />
                        {vfError}
                      </p>
                    {/if}
                  </form>
                {:else}
                  <button class="btn h-7" onclick={() => openAddVariant(p.id)}>
                    <Icon name="plus" size={12} />
                    Add variant
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
{/if}

<!-- product create / edit -->
<Dialog
  open={productFormOpen}
  title={editingProductId ? "Edit product" : "New product"}
  size="sm"
  dismissible={!pfBusy}
  onclose={() => (productFormOpen = false)}
>
  <form
    class="space-y-3 px-5 pb-4"
    onsubmit={(e) => {
      e.preventDefault();
      submitProduct();
    }}
  >
    <label class="block">
      <span class="mb-1 block text-[12px] text-t2">Name</span>
      <input data-autofocus class="input" bind:value={pfName} autocomplete="off" required />
    </label>
    <label class="block">
      <span class="mb-1 block text-[12px] text-t2">Category</span>
      <select class="input" bind:value={pfCategory}>
        <option value="">Uncategorised</option>
        {#each categories as c (c.id)}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    </label>
    <label class="block">
      <span class="mb-1 block text-[12px] text-t2">Description</span>
      <textarea class="input" rows="2" bind:value={pfDescription}></textarea>
    </label>
    {#if pfError}
      <p
        class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        role="alert"
      >
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {pfError}
      </p>
    {/if}
  </form>
  {#snippet footer()}
    <button class="btn" disabled={pfBusy} onclick={() => (productFormOpen = false)}>
      Cancel
    </button>
    <button class="btn btn-primary" disabled={pfBusy || !pfName.trim()} onclick={submitProduct}>
      {#if pfBusy}<Icon name="refresh" size={13} class="animate-spin" />{/if}
      {pfBusy ? "Saving…" : editingProductId ? "Save changes" : "Add product"}
    </button>
  {/snippet}
</Dialog>

<ConfirmDialog
  open={confirmDeleteProduct !== null}
  title="Delete {confirmDeleteProduct?.name ?? ''}?"
  body={deleteProductBody}
  confirmLabel="Delete product"
  tone="danger"
  busy={deleteProductBusy}
  error={deleteProductError}
  onconfirm={commitDeleteProduct}
  oncancel={() => (confirmDeleteProduct = null)}
/>

<ConfirmDialog
  open={confirmDeleteVariant !== null}
  title="Delete variant {confirmDeleteVariant?.name ?? ''}?"
  body="Core refuses if this variant has any stock movement or order line against it — that is trade history, and nothing here can force past it."
  confirmLabel="Delete variant"
  tone="danger"
  busy={deleteVariantBusy}
  error={deleteVariantError}
  onconfirm={commitDeleteVariant}
  oncancel={() => (confirmDeleteVariant = null)}
/>

<!-- manage categories -->
<Dialog
  open={categoriesOpen}
  title="Manage categories"
  description="Distinct from transaction categories elsewhere in SlipScan — these group products only."
  size="sm"
  onclose={() => (categoriesOpen = false)}
>
  <div class="space-y-3 px-5 pb-4">
    <form
      class="flex items-center gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        addCategory();
      }}
    >
      <label class="flex-1">
        <span class="sr-only">New category name</span>
        <input class="input" placeholder="New category name" bind:value={newCategoryName} autocomplete="off" />
      </label>
      <button class="btn btn-primary h-9" type="submit" disabled={categoryBusy || !newCategoryName.trim()}>
        Add
      </button>
    </form>

    {#if categoryError}
      <p
        class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        role="alert"
      >
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {categoryError}
      </p>
    {/if}

    {#if categories.length === 0}
      <p class="text-[12px] text-t3">
        No categories yet. A product can stay uncategorised — a category only
        groups them for filtering, nothing depends on one existing.
      </p>
    {:else}
      <ul class="divide-y divide-line rounded-lg border border-line">
        {#each categories as c (c.id)}
          <li class="flex items-center gap-2 px-3 py-2">
            {#if renamingId === c.id}
              <input
                data-autofocus
                class="input h-7 flex-1"
                bind:value={renameValue}
                aria-label="Rename {c.name}"
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename(c);
                  } else if (e.key === "Escape") {
                    renamingId = null;
                  }
                }}
              />
              <button class="btn h-7" disabled={categoryBusy} onclick={() => commitRename(c)}>
                Save
              </button>
              <button class="btn btn-ghost h-7" onclick={() => (renamingId = null)}>
                Cancel
              </button>
            {:else}
              <span class="min-w-0 flex-1 truncate text-[12.5px]">{c.name}</span>
              <span class="num text-[11px] text-t3">
                {products.filter((p) => p.product_category_id === c.id).length}
              </span>
              <button
                class="btn btn-ghost h-7 w-7 px-0"
                aria-label="Rename {c.name}"
                onclick={() => startRename(c)}
              >
                <Icon name="pencil" size={12} />
              </button>
              <button
                class="btn btn-ghost h-7 w-7 px-0 hover:text-danger"
                aria-label="Delete category {c.name}"
                onclick={() => askDeleteCategory(c)}
              >
                <Icon name="trash" size={12} />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="text-[11px] text-t3">
        Deleting a category leaves its products in place, moved to
        Uncategorised — it never takes a product with it.
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (categoriesOpen = false)}>Close</button>
  {/snippet}
</Dialog>

<ConfirmDialog
  open={confirmDeleteCategory !== null}
  title="Delete category “{confirmDeleteCategory?.name ?? ''}”?"
  body="Its products stay, moved to Uncategorised. Nothing about them changes otherwise."
  confirmLabel="Delete category"
  tone="danger"
  busy={deleteCategoryBusy}
  error={categoryError}
  onconfirm={commitDeleteCategory}
  oncancel={() => (confirmDeleteCategory = null)}
/>
