package classify

import (
	"context"
	"database/sql"
	"net/http"

	"github.com/google/uuid"

	"github.com/exolutionza/slipscan/backend/internal/httpx"
)

// CategoryItem is a single row returned by the categories list endpoint —
// everything the correction picker needs to render the org's category tree.
type CategoryItem struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parent_id,omitempty"`
	Name     string  `json:"name"`
	Kind     string  `json:"kind"`
	Icon     *string `json:"icon,omitempty"`
	Color    *string `json:"color,omitempty"`
}

// ListCategories returns the org's categories ordered for tree display
// (parents before children, alphabetical within a level).
func ListCategories(ctx context.Context, db *sql.DB, orgID uuid.UUID) ([]CategoryItem, error) {
	const q = `
		SELECT id, parent_id, name, kind, icon, color
		FROM categories
		WHERE organization_id = $1
		ORDER BY (parent_id IS NOT NULL), name
	`
	rows, err := db.QueryContext(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]CategoryItem, 0, 64)
	for rows.Next() {
		var (
			id              uuid.UUID
			parent          uuid.NullUUID
			name, kind      string
			icon, color     sql.NullString
		)
		if err := rows.Scan(&id, &parent, &name, &kind, &icon, &color); err != nil {
			return nil, err
		}
		item := CategoryItem{ID: id.String(), Name: name, Kind: kind}
		if parent.Valid {
			s := parent.UUID.String()
			item.ParentID = &s
		}
		if icon.Valid {
			item.Icon = &icon.String
		}
		if color.Valid {
			item.Color = &color.String
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// ListCategories handles GET /orgs/{orgID}/categories.
func (h *Handler) ListCategories(w http.ResponseWriter, r *http.Request) {
	orgID, ok := parseUUID(r, "orgID")
	if !ok {
		httpx.WriteError(w, http.StatusBadRequest, "invalid_org_id", "invalid organization id")
		return
	}
	cats, err := ListCategories(r.Context(), h.db, orgID)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "list_failed", "could not list categories")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"categories": cats})
}
