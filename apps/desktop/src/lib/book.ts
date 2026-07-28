/**
 * "Which book is this screen about", and what to say when there is none.
 *
 * A fresh install genuinely has no book: the desktop backend stopped
 * inventing one (`src-tauri/src/state.rs`), because a book written before
 * the user answered the region and currency questions could never afterwards
 * be the book they answered them for. So "no book yet" is a real, expected
 * state — and every screen has to say something useful about it rather than
 * surfacing a bare `no book configured`.
 *
 * The desktop is single-book today: `book_list` is `ORDER BY created_at, id`
 * and every screen reads the first row. That is a limitation, not a
 * preference, and Settings › General states it where a second book could be
 * made. `currentBook` is the one place that assumption lives, so the day a
 * book switcher lands there is exactly one function to change.
 */
import type { Book } from "./api/types";

/**
 * What a screen shows instead of data when the database holds no book.
 * Deliberately names both routes out, because the palette is discoverable
 * only if something tells you it is there.
 */
export const NO_BOOK_MESSAGE =
  "No book yet. Press ⌘K and choose “Set up a new book”, or create one in Settings › General.";

/** The book the desktop screens work with, or `null` when there is none. */
export function currentBook(books: Book[]): Book | null {
  return books[0] ?? null;
}

/**
 * The current book, or a throw carrying [`NO_BOOK_MESSAGE`]. Screens load
 * inside an `{#await}`, so throwing is how they reach their error state —
 * this only makes that state legible.
 */
export function requireBook(books: Book[]): Book {
  const book = currentBook(books);
  if (!book) throw new Error(NO_BOOK_MESSAGE);
  return book;
}
