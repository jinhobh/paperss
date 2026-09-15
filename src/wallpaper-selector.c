#include <cairo.h>
#include <gdk/gdk.h>
#include <gdk/gdkkeysyms.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <gio/gio.h>
#include <glib/gstdio.h>
#include <gtk/gtk.h>

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define APP_ID "io.github.jinho.PaperssWallpaper"
#define THUMBNAIL_WIDTH 900
#define THUMBNAIL_HEIGHT 600
#define THUMBNAIL_RADIUS 2

#define STATE_DIR ".local/share/rice"
#define STATE_FILE "state.json"
#define COLORS_FILE "colors.json"
#define PROFILES_FILE "wallpaper-themes.json"

#define UNUSED(value) ((void)(value))

typedef struct _Selector Selector;
typedef struct _AppState AppState;

typedef struct {
    Selector *selector;
    gchar *path;
} ThumbnailRequest;

typedef struct {
    Selector *selector;
    gchar *path;
    GdkPixbuf *pixbuf;
} ThumbnailResult;

typedef struct {
    gchar *output;
    gchar *error;
    gboolean success;
} ApplyResult;

struct _AppState {
    GtkApplication *application;
    Selector *selector;
};

struct _Selector {
    AppState *app;
    GtkApplicationWindow *window;
    GtkDrawingArea *canvas;
    GPtrArray *items;
    guint index;
    gboolean applying;
    gchar *error;
    guint commit_timer;
    GHashTable *pixbufs;
    GHashTable *loading;
    GHashTable *failed;
    GHashTable *colors;
    GThreadPool *thumbnail_pool;
};

static gchar *path_join_home(const gchar *relative)
{
    return g_build_filename(g_get_home_dir(), relative, NULL);
}

static gchar *read_text_file(const gchar *path)
{
    gchar *contents = NULL;
    gsize length = 0;
    if (!g_file_get_contents(path, &contents, &length, NULL)) {
        return NULL;
    }
    return contents;
}

static const gchar *skip_json_space(const gchar *cursor, const gchar *end)
{
    while (cursor < end && g_ascii_isspace(*cursor)) {
        cursor++;
    }
    return cursor;
}

static const gchar *json_key_value(const gchar *json, const gchar *end,
                                   const gchar *key)
{
    gchar *needle = g_strdup_printf("\"%s\"", key);
    const gchar *cursor = json;
    gsize needle_length = strlen(needle);

    while (cursor < end) {
        const gchar *match = g_strstr_len(cursor, (gssize)(end - cursor), needle);
        if (match == NULL) {
            break;
        }
        const gchar *after_key = match + needle_length;
        after_key = skip_json_space(after_key, end);
        if (after_key < end && *after_key == ':') {
            g_free(needle);
            return skip_json_space(after_key + 1, end);
        }
        cursor = match + 1;
    }

    g_free(needle);
    return NULL;
}

static gchar *json_string_value(const gchar *json, const gchar *end,
                                const gchar *key)
{
    const gchar *cursor = json_key_value(json, end, key);
    if (cursor == NULL || cursor >= end || *cursor != '\"') {
        return NULL;
    }

    cursor++;
    GString *value = g_string_new(NULL);
    while (cursor < end && *cursor != '\"') {
        if (*cursor == '\\' && cursor + 1 < end) {
            cursor++;
            switch (*cursor) {
            case 'n': g_string_append_c(value, '\n'); break;
            case 'r': g_string_append_c(value, '\r'); break;
            case 't': g_string_append_c(value, '\t'); break;
            default: g_string_append_c(value, *cursor); break;
            }
        } else {
            g_string_append_c(value, *cursor);
        }
        cursor++;
    }
    return g_string_free(value, FALSE);
}

static gchar *json_scalar_value(const gchar *json, const gchar *end,
                                const gchar *key)
{
    const gchar *cursor = json_key_value(json, end, key);
    if (cursor == NULL) {
        return NULL;
    }

    const gchar *finish = cursor;
    while (finish < end && *finish != ',' && *finish != '}') {
        finish++;
    }
    while (finish > cursor && g_ascii_isspace(finish[-1])) {
        finish--;
    }
    return g_strndup(cursor, (gsize)(finish - cursor));
}

static gchar *json_profile_value(const gchar *json, const gchar *path,
                                 const gchar *key, gboolean string_value)
{
    gchar *escaped = g_strescape(path, NULL);
    gchar *needle = g_strdup_printf("\"%s\"", escaped);
    const gchar *entry = g_strstr_len(json, -1, needle);
    gchar *value = NULL;

    if (entry != NULL) {
        const gchar *end = strchr(entry, '}');
        if (end != NULL) {
            value = string_value
                ? json_string_value(entry, end, key)
                : json_scalar_value(entry, end, key);
        }
    }

    g_free(needle);
    g_free(escaped);
    return value;
}

static const gchar *palette_color(Selector *selector, const gchar *name,
                                  const gchar *fallback)
{
    const gchar *value = g_hash_table_lookup(selector->colors, name);
    return value != NULL ? value : fallback;
}

static void rgba_from_hex(const gchar *hex, gdouble alpha, gdouble *red,
                          gdouble *green, gdouble *blue, gdouble *out_alpha)
{
    guint values[3] = {255, 255, 255};
    if (hex != NULL && hex[0] == '#' && strlen(hex) >= 7) {
        gchar component[3] = {0, 0, 0};
        for (guint i = 0; i < 3; i++) {
            component[0] = hex[1 + i * 2];
            component[1] = hex[2 + i * 2];
            values[i] = (guint)strtoul(component, NULL, 16);
        }
    }
    *red = values[0] / 255.0;
    *green = values[1] / 255.0;
    *blue = values[2] / 255.0;
    *out_alpha = alpha;
}

static gchar *thumbnail_cache_path(const gchar *path)
{
    GStatBuf stat_buffer;
    if (g_stat(path, &stat_buffer) != 0) {
        return NULL;
    }

    gchar *identity = g_strdup_printf(
        "%s|%" G_GINT64_FORMAT "|%" G_GINT64_FORMAT "|%dx%d",
        path, (gint64)stat_buffer.st_size, (gint64)stat_buffer.st_mtime,
        THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    gchar *digest = g_compute_checksum_for_string(G_CHECKSUM_SHA256, identity, -1);
    const gchar *cache_home = g_get_user_cache_dir();
    gchar *filename = g_strdup_printf("%s.png", digest);
    gchar *cache = g_build_filename(cache_home, "rice", "wallpaper-thumbnails",
                                    filename, NULL);

    g_free(filename);
    g_free(digest);
    g_free(identity);
    return cache;
}

static GdkPixbuf *load_pixbuf_file(const gchar *path)
{
    GError *error = NULL;
    GdkPixbuf *pixbuf = gdk_pixbuf_new_from_file_at_scale(
        path, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, TRUE, &error);
    if (pixbuf == NULL) {
        g_clear_error(&error);
    }
    return pixbuf;
}

static GdkPixbuf *load_thumbnail(const gchar *path)
{
    gchar *cache = thumbnail_cache_path(path);
    GdkPixbuf *pixbuf = NULL;

    if (cache != NULL && g_file_test(cache, G_FILE_TEST_IS_REGULAR)) {
        pixbuf = load_pixbuf_file(cache);
        if (pixbuf != NULL) {
            g_free(cache);
            return pixbuf;
        }
        g_unlink(cache);
    }

    pixbuf = load_pixbuf_file(path);
    if (pixbuf == NULL) {
        g_free(cache);
        return NULL;
    }

    if (cache != NULL) {
        gchar *directory = g_path_get_dirname(cache);
        g_mkdir_with_parents(directory, 0700);
        gchar *temporary = g_strdup_printf(
            "%s.%u-%p.tmp", cache, (guint)getpid(), (void *)pixbuf);
        GError *error = NULL;
        if (gdk_pixbuf_savev(pixbuf, temporary, "png", NULL, NULL, &error)) {
            g_rename(temporary, cache);
        } else {
            g_clear_error(&error);
            g_unlink(temporary);
        }
        g_free(temporary);
        g_free(directory);
    }

    g_free(cache);
    return pixbuf;
}

static gboolean thumbnail_loaded_on_main(gpointer user_data)
{
    ThumbnailResult *result = user_data;
    Selector *selector = result->selector;

    g_hash_table_remove(selector->loading, result->path);
    if (result->pixbuf != NULL) {
        g_hash_table_replace(selector->pixbufs, g_strdup(result->path),
                             result->pixbuf);
        result->pixbuf = NULL;
    } else {
        g_hash_table_add(selector->failed, g_strdup(result->path));
    }

    gtk_widget_queue_draw(GTK_WIDGET(selector->canvas));
    g_free(result->path);
    g_clear_object(&result->pixbuf);
    g_free(result);
    return G_SOURCE_REMOVE;
}

static void thumbnail_worker(gpointer user_data, gpointer pool_data)
{
    UNUSED(pool_data);
    ThumbnailRequest *request = user_data;
    ThumbnailResult *result = g_new0(ThumbnailResult, 1);
    result->selector = request->selector;
    result->path = g_strdup(request->path);
    result->pixbuf = load_thumbnail(request->path);
    g_main_context_invoke(NULL, thumbnail_loaded_on_main, result);
    g_free(request->path);
    g_free(request);
}

static void request_thumbnail(Selector *selector, const gchar *path)
{
    if (g_hash_table_contains(selector->pixbufs, path) ||
        g_hash_table_contains(selector->loading, path) ||
        g_hash_table_contains(selector->failed, path)) {
        return;
    }

    g_hash_table_add(selector->loading, g_strdup(path));
    ThumbnailRequest *request = g_new0(ThumbnailRequest, 1);
    request->selector = selector;
    request->path = g_strdup(path);
    g_thread_pool_push(selector->thumbnail_pool, request, NULL);
}

static gboolean image_file(const gchar *path)
{
    GFile *file = g_file_new_for_path(path);
    GFileInfo *info = g_file_query_info(
        file, G_FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
        G_FILE_QUERY_INFO_NONE, NULL, NULL);
    gboolean result = FALSE;
    if (info != NULL) {
        const gchar *content_type = g_file_info_get_attribute_string(
            info, G_FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE);
        result = content_type != NULL && g_str_has_prefix(content_type, "image/");
    }
    g_clear_object(&info);
    g_object_unref(file);
    return result;
}

static gint compare_paths(gconstpointer first, gconstpointer second)
{
    const gchar *left = *(const gchar * const *)first;
    const gchar *right = *(const gchar * const *)second;
    gchar *left_folded = g_utf8_casefold(left, -1);
    gchar *right_folded = g_utf8_casefold(right, -1);
    gint result = g_strcmp0(left_folded, right_folded);
    g_free(left_folded);
    g_free(right_folded);
    return result;
}

static GPtrArray *find_wallpapers(void)
{
    const gchar *configured = g_getenv("RICE_WALLPAPER_DIR");
    gchar *directory = configured != NULL && *configured != '\0'
        ? g_strdup(configured)
        : path_join_home("Pictures/Wallpapers");
    GPtrArray *items = g_ptr_array_new_with_free_func(g_free);
    GDir *dir = g_dir_open(directory, 0, NULL);

    if (dir != NULL) {
        const gchar *name;
        while ((name = g_dir_read_name(dir)) != NULL) {
            gchar *path = g_build_filename(directory, name, NULL);
            if (g_file_test(path, G_FILE_TEST_IS_REGULAR) && image_file(path)) {
                gchar *resolved = g_canonicalize_filename(path, NULL);
                g_ptr_array_add(items, resolved);
            }
            g_free(path);
        }
        g_dir_close(dir);
    }

    g_ptr_array_sort(items, compare_paths);
    g_free(directory);
    return items;
}

static gchar *load_colors(void)
{
    gchar *path = path_join_home(STATE_DIR "/" COLORS_FILE);
    gchar *contents = read_text_file(path);
    g_free(path);
    return contents;
}

static GHashTable *palette_from_file(void)
{
    GHashTable *colors = g_hash_table_new_full(
        g_str_hash, g_str_equal, g_free, g_free);
    gchar *json = load_colors();
    if (json == NULL) {
        return colors;
    }

    const gchar *names[] = {
        "surface", "surface_high", "surface_low", "primary", "outline",
        "outline_variant", "on_surface", "on_surface_variant", "tertiary",
        "secondary", "error", "green", "red", "yellow", "primary_container",
        "mode", NULL,
    };
    for (guint i = 0; names[i] != NULL; i++) {
        gchar *value = json_string_value(json, json + strlen(json), names[i]);
        if (value != NULL) {
            g_hash_table_insert(colors, g_strdup(names[i]), value);
        }
    }
    g_free(json);
    return colors;
}

static guint current_wallpaper_index(GPtrArray *items)
{
    gchar *state_path = path_join_home(STATE_DIR "/" STATE_FILE);
    gchar *state = read_text_file(state_path);
    g_free(state_path);
    if (state == NULL) {
        return 0;
    }

    gchar *current = json_string_value(state, state + strlen(state), "wallpaper");
    guint index = 0;
    if (current != NULL) {
        for (guint i = 0; i < items->len; i++) {
            if (g_strcmp0(current, g_ptr_array_index(items, i)) == 0) {
                index = i;
                break;
            }
        }
    }
    g_free(current);
    g_free(state);
    return index;
}

static void preload_nearby(Selector *selector)
{
    if (selector->items->len == 0) {
        return;
    }
    for (gint offset = -2; offset <= 2; offset++) {
        gint index = (gint)selector->index + offset;
        while (index < 0) {
            index += (gint)selector->items->len;
        }
        index %= (gint)selector->items->len;
        request_thumbnail(selector, g_ptr_array_index(selector->items, index));
    }
}

static void polygon(cairo_t *cr, gdouble x, gdouble y, gdouble width,
                    gdouble height, gdouble slant)
{
    cairo_move_to(cr, x + slant, y);
    cairo_line_to(cr, x + width, y);
    cairo_line_to(cr, x + width - slant, y + height);
    cairo_line_to(cr, x, y + height);
    cairo_close_path(cr);
}

static void draw_image(Selector *selector, cairo_t *cr, const gchar *path,
                       gdouble x, gdouble y, gdouble width, gdouble height,
                       gdouble alpha)
{
    GdkPixbuf *pixbuf = g_hash_table_lookup(selector->pixbufs, path);
    if (pixbuf == NULL) {
        request_thumbnail(selector, path);
        gdouble red, green, blue, actual_alpha;
        rgba_from_hex(palette_color(selector, "surface_high", "#263238"),
                      alpha, &red, &green, &blue, &actual_alpha);
        cairo_set_source_rgba(cr, red, green, blue, actual_alpha);
        cairo_paint(cr);
        return;
    }

    gdouble pixbuf_width = gdk_pixbuf_get_width(pixbuf);
    gdouble pixbuf_height = gdk_pixbuf_get_height(pixbuf);
    gdouble scale = MAX(width / pixbuf_width, height / pixbuf_height);
    gdouble offset_x = x + (width - pixbuf_width * scale) / 2.0;
    gdouble offset_y = y + (height - pixbuf_height * scale) / 2.0;

    cairo_save(cr);
    cairo_translate(cr, offset_x, offset_y);
    cairo_scale(cr, scale, scale);
    gdk_cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
    cairo_paint_with_alpha(cr, alpha);
    cairo_restore(cr);
}

static void draw_card(Selector *selector, cairo_t *cr, const gchar *path,
                      gint delta, gdouble width, gdouble height)
{
    gboolean selected = delta == 0;
    gdouble base_width = MIN(570.0, width * 0.42);
    gdouble card_width = selected ? base_width : base_width * 0.80;
    gdouble card_height = card_width * 0.58;
    gdouble step = base_width * 0.66;
    gdouble x = width / 2.0 - card_width / 2.0 + delta * step;
    gdouble y = height / 2.0 - card_height / 2.0 + (selected ? 0 : 15);
    gdouble slant = card_width * 0.13;
    const gchar *accent = palette_color(selector, "primary", "#8bd0f0");
    const gchar *outline = palette_color(selector, "outline", "#9aa5ad");

    const gdouble spreads[] = {28, 14, 7};
    const gdouble opacities[] = {0.035, 0.065, 0.10};
    for (guint i = 0; i < G_N_ELEMENTS(spreads); i++) {
        cairo_save(cr);
        polygon(cr, x - spreads[i], y - spreads[i],
                card_width + spreads[i] * 2, card_height + spreads[i] * 2,
                slant);
        gdouble red, green, blue, alpha;
        rgba_from_hex(accent, opacities[i] * (selected ? 1.0 : 0.35),
                      &red, &green, &blue, &alpha);
        cairo_set_source_rgba(cr, red, green, blue, alpha);
        cairo_fill(cr);
        cairo_restore(cr);
    }

    cairo_save(cr);
    polygon(cr, x, y, card_width, card_height, slant);
    cairo_clip(cr);
    draw_image(selector, cr, path, x, y, card_width, card_height,
               selected ? 1.0 : 0.48);
    if (!selected) {
        gdouble red, green, blue, alpha;
        rgba_from_hex(palette_color(selector, "surface", "#10161a"), 0.25,
                      &red, &green, &blue, &alpha);
        cairo_set_source_rgba(cr, red, green, blue, alpha);
        cairo_paint(cr);
    }
    cairo_restore(cr);

    cairo_save(cr);
    polygon(cr, x, y, card_width, card_height, slant);
    gdouble red, green, blue, alpha;
    rgba_from_hex(selected ? accent : outline, selected ? 0.96 : 0.28,
                  &red, &green, &blue, &alpha);
    cairo_set_source_rgba(cr, red, green, blue, alpha);
    cairo_set_line_width(cr, selected ? 3.0 : 1.0);
    cairo_stroke(cr);
    cairo_restore(cr);
}

static void draw(GtkDrawingArea *area, cairo_t *cr, int width, int height,
                 gpointer user_data)
{
    UNUSED(area);
    Selector *selector = user_data;
    gdouble red, green, blue, alpha;
    rgba_from_hex(palette_color(selector, "surface", "#10161a"), 0.72,
                  &red, &green, &blue, &alpha);
    cairo_set_source_rgba(cr, red, green, blue, alpha);
    cairo_paint(cr);

    if (selector->items->len == 0) {
        return;
    }

    GArray *visible = g_array_new(FALSE, FALSE, sizeof(gint));
    for (guint i = 0; i < selector->items->len; i++) {
        gint raw = ((gint)i - (gint)selector->index) % (gint)selector->items->len;
        if (raw < 0) {
            raw += (gint)selector->items->len;
        }
        gint delta = raw <= (gint)selector->items->len / 2
            ? raw
            : raw - (gint)selector->items->len;
        if (abs(delta) <= 2) {
            g_array_append_val(visible, delta);
        }
    }

    for (guint pass = 0; pass < 2; pass++) {
        for (guint i = 0; i < visible->len; i++) {
            gint delta = g_array_index(visible, gint, i);
            if ((pass == 0 && delta == 0) || (pass == 1 && delta != 0)) {
                guint index = (selector->index + selector->items->len + delta) %
                              selector->items->len;
                draw_card(selector, cr, g_ptr_array_index(selector->items, index),
                          delta, width, height);
            }
        }
    }
    g_array_unref(visible);
}

static gboolean hide_selector(gpointer user_data)
{
    Selector *selector = user_data;
    selector->commit_timer = 0;
    gtk_widget_set_visible(GTK_WIDGET(selector->window), FALSE);
    return G_SOURCE_REMOVE;
}

static void commit(Selector *selector);

static gboolean commit_timer_expired(gpointer user_data)
{
    Selector *selector = user_data;
    selector->commit_timer = 0;
    commit(selector);
    return G_SOURCE_REMOVE;
}

static void arm_commit_timer(Selector *selector)
{
    if (selector->commit_timer != 0) {
        g_source_remove(selector->commit_timer);
    }
    selector->commit_timer = g_timeout_add(4500, commit_timer_expired, selector);
}

static void cycle(Selector *selector, gint direction)
{
    if (selector->applying || selector->items->len == 0) {
        return;
    }
    selector->index = (selector->index + selector->items->len + direction) %
                      selector->items->len;
    preload_nearby(selector);
    gtk_widget_queue_draw(GTK_WIDGET(selector->canvas));
    arm_commit_timer(selector);
}

static gboolean key_pressed(GtkEventControllerKey *controller, guint keyval,
                            guint keycode, GdkModifierType state,
                            gpointer user_data)
{
    UNUSED(controller);
    UNUSED(keycode);
    Selector *selector = user_data;
    switch (keyval) {
    case GDK_KEY_Escape:
        gtk_window_close(GTK_WINDOW(selector->window));
        return TRUE;
    case GDK_KEY_Return:
    case GDK_KEY_KP_Enter:
    case GDK_KEY_space:
        /* Commit is declared below; Enter is handled by the click-equivalent. */
        break;
    case GDK_KEY_Left:
    case GDK_KEY_h:
        cycle(selector, -1);
        return TRUE;
    case GDK_KEY_Right:
    case GDK_KEY_l:
        cycle(selector, 1);
        return TRUE;
    case GDK_KEY_Tab:
    case GDK_KEY_ISO_Left_Tab:
        cycle(selector, keyval == GDK_KEY_ISO_Left_Tab ||
                       (state & GDK_SHIFT_MASK) ? -1 : 1);
        return TRUE;
    default:
        return FALSE;
    }

    /* The commit callback is installed on the selector as a function pointer. */
    return FALSE;
}

static gchar *retheme_path(void)
{
    const gchar *configured = g_getenv("PAPERSS_RETHEME");
    if (configured != NULL && g_file_test(configured, G_FILE_TEST_IS_EXECUTABLE)) {
        return g_strdup(configured);
    }

    gchar *installed = path_join_home(".local/bin/retheme");
    if (g_file_test(installed, G_FILE_TEST_IS_EXECUTABLE)) {
        return installed;
    }
    g_free(installed);

    const gchar *candidates[] = {"rice/bin/retheme", "paperss/bin/retheme", NULL};
    for (guint i = 0; candidates[i] != NULL; i++) {
        gchar *candidate = path_join_home(candidates[i]);
        if (g_file_test(candidate, G_FILE_TEST_IS_EXECUTABLE)) {
            return candidate;
        }
        g_free(candidate);
    }
    return NULL;
}

static gchar **retheme_argv(const gchar *selected)
{
    gchar *retheme = retheme_path();
    if (retheme == NULL) {
        return NULL;
    }

    gchar *profile_path = path_join_home(STATE_DIR "/" PROFILES_FILE);
    gchar *profiles = read_text_file(profile_path);
    gchar *seed = profiles == NULL ? NULL
        : json_profile_value(profiles, selected, "seed", TRUE);
    GPtrArray *args = g_ptr_array_new_with_free_func(g_free);
    g_ptr_array_add(args, retheme);

    if (seed == NULL) {
        g_ptr_array_add(args, g_strdup(selected));
    } else {
        g_ptr_array_add(args, g_strdup("--seed"));
        g_ptr_array_add(args, seed);
        g_ptr_array_add(args, g_strdup("--wallpaper"));
        g_ptr_array_add(args, g_strdup(selected));

        const gchar *string_options[] = {"scheme", "mode", NULL};
        for (guint i = 0; string_options[i] != NULL; i++) {
            gchar *value = json_profile_value(
                profiles, selected, string_options[i], TRUE);
            if (value != NULL) {
                g_ptr_array_add(args, g_strdup_printf("--%s", string_options[i]));
                g_ptr_array_add(args, value);
            }
        }
        const gchar *number_options[] = {"tint", "paper", NULL};
        for (guint i = 0; number_options[i] != NULL; i++) {
            gchar *value = json_profile_value(
                profiles, selected, number_options[i], FALSE);
            if (value != NULL) {
                g_ptr_array_add(args, g_strdup_printf("--%s", number_options[i]));
                g_ptr_array_add(args, value);
            }
        }
    }

    g_ptr_array_add(args, NULL);
    gchar **result = (gchar **)g_ptr_array_free(args, FALSE);
    g_free(profiles);
    g_free(profile_path);
    return result;
}

static void apply_result_free(ApplyResult *result)
{
    if (result == NULL) {
        return;
    }
    g_free(result->output);
    g_free(result->error);
    g_free(result);
}

static void apply_worker(GTask *task, gpointer source_object,
                         gpointer task_data, GCancellable *cancellable)
{
    UNUSED(source_object);
    UNUSED(cancellable);
    const gchar *selected = task_data;
    gchar **argv = retheme_argv(selected);
    ApplyResult *result = g_new0(ApplyResult, 1);

    if (argv == NULL) {
        result->error = g_strdup("could not find retheme; run install.sh first");
        g_task_return_pointer(task, result, (GDestroyNotify)apply_result_free);
        return;
    }

    GError *error = NULL;
    GSubprocess *process = g_subprocess_newv(
        (const gchar * const *)argv,
        G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_MERGE,
        &error);
    g_strfreev(argv);
    if (process == NULL) {
        result->error = g_strdup(error != NULL ? error->message : "could not start retheme");
        g_clear_error(&error);
        g_task_return_pointer(task, result, (GDestroyNotify)apply_result_free);
        return;
    }

    gchar *output = NULL;
    if (!g_subprocess_communicate_utf8(process, NULL, NULL, &output, NULL,
                                       &error)) {
        result->error = g_strdup(error != NULL ? error->message : "retheme failed");
        g_clear_error(&error);
    } else {
        result->output = output != NULL ? output : g_strdup("");
        result->success = g_subprocess_get_successful(process);
        if (!result->success) {
            result->error = g_strdup("retheme exited unsuccessfully");
        }
    }
    g_object_unref(process);
    g_task_return_pointer(task, result, (GDestroyNotify)apply_result_free);
}

static gchar *runtime_log_path(void)
{
    const gchar *runtime = g_get_user_runtime_dir();
    return g_build_filename(runtime, "rice-wallpaper-selector.log", NULL);
}

static void apply_done(GObject *source_object, GAsyncResult *async_result,
                       gpointer user_data)
{
    UNUSED(source_object);
    Selector *selector = user_data;
    GError *error = NULL;
    ApplyResult *result = g_task_propagate_pointer(
        G_TASK(async_result), &error);
    gchar *log_path = runtime_log_path();

    if (result != NULL && result->output != NULL) {
        g_file_set_contents(log_path, result->output, -1, NULL);
    }
    g_free(log_path);

    if (error != NULL) {
        g_free(selector->error);
        selector->error = g_strdup(error->message);
        g_clear_error(&error);
        selector->applying = FALSE;
        gtk_widget_queue_draw(GTK_WIDGET(selector->canvas));
        g_timeout_add(2600, hide_selector, selector);
    } else if (result != NULL && result->success) {
        selector->applying = FALSE;
        hide_selector(selector);
    } else {
        g_free(selector->error);
        selector->error = g_strdup(result != NULL && result->error != NULL
                                       ? result->error
                                       : "retheme failed");
        selector->applying = FALSE;
        gtk_widget_queue_draw(GTK_WIDGET(selector->canvas));
        g_timeout_add(2600, hide_selector, selector);
    }
    apply_result_free(result);
}

static void commit(Selector *selector)
{
    if (selector->applying || selector->items->len == 0) {
        return;
    }
    selector->applying = TRUE;
    if (selector->commit_timer != 0) {
        g_source_remove(selector->commit_timer);
        selector->commit_timer = 0;
    }
    gtk_widget_queue_draw(GTK_WIDGET(selector->canvas));

    const gchar *selected = g_ptr_array_index(selector->items, selector->index);
    GTask *task = g_task_new(NULL, NULL, apply_done, selector);
    g_task_set_task_data(task, g_strdup(selected), g_free);
    g_task_run_in_thread(task, apply_worker);
    g_object_unref(task);
}

static gboolean key_pressed_real(GtkEventControllerKey *controller, guint keyval,
                                 guint keycode, GdkModifierType state,
                                 gpointer user_data)
{
    UNUSED(controller);
    UNUSED(keycode);
    Selector *selector = user_data;
    if (keyval == GDK_KEY_Return || keyval == GDK_KEY_KP_Enter ||
        keyval == GDK_KEY_space) {
        commit(selector);
        return TRUE;
    }
    return key_pressed(controller, keyval, keycode, state, user_data);
}

static void key_released(GtkEventControllerKey *controller, guint keyval,
                         guint keycode, GdkModifierType state,
                         gpointer user_data)
{
    UNUSED(controller);
    UNUSED(keycode);
    UNUSED(state);
    Selector *selector = user_data;
    if (keyval == GDK_KEY_Super_L || keyval == GDK_KEY_Super_R) {
        commit(selector);
    }
}

static void clicked(GtkGestureClick *gesture, guint n_press, gdouble x,
                    gdouble y, gpointer user_data)
{
    UNUSED(gesture);
    UNUSED(n_press);
    Selector *selector = user_data;
    gdouble width = gtk_widget_get_width(GTK_WIDGET(selector->window));
    gdouble height = gtk_widget_get_height(GTK_WIDGET(selector->window));
    gdouble card_width = MIN(570.0, width * 0.42);
    gdouble card_height = card_width * 0.58;
    if (fabs(x - width / 2.0) < card_width / 2.0 &&
        fabs(y - height / 2.0) < card_height / 2.0) {
        commit(selector);
    }
}

static gboolean close_request(GtkWindow *window, gpointer user_data)
{
    UNUSED(window);
    Selector *selector = user_data;
    if (selector->commit_timer != 0) {
        g_source_remove(selector->commit_timer);
        selector->commit_timer = 0;
    }
    selector->applying = FALSE;
    gtk_widget_set_visible(GTK_WIDGET(selector->window), FALSE);
    return TRUE;
}

static Selector *selector_new(AppState *app)
{
    Selector *selector = g_new0(Selector, 1);
    selector->app = app;
    selector->items = find_wallpapers();
    selector->index = current_wallpaper_index(selector->items);
    selector->pixbufs = g_hash_table_new_full(
        g_str_hash, g_str_equal, g_free, g_object_unref);
    selector->loading = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    selector->failed = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    selector->colors = palette_from_file();
    selector->thumbnail_pool = g_thread_pool_new(
        thumbnail_worker, NULL, 2, FALSE, NULL);

    selector->window = GTK_APPLICATION_WINDOW(
        gtk_application_window_new(app->application));
    gtk_window_set_title(GTK_WINDOW(selector->window), "Paperss Wallpaper Selector");
    gtk_window_set_decorated(GTK_WINDOW(selector->window), FALSE);
    gtk_window_set_default_size(GTK_WINDOW(selector->window), 1200, 680);
    gtk_window_fullscreen(GTK_WINDOW(selector->window));

    GtkCssProvider *css = gtk_css_provider_new();
    gtk_css_provider_load_from_data(css, "window { background: transparent; }", -1);
    gtk_style_context_add_provider_for_display(
        gdk_display_get_default(), GTK_STYLE_PROVIDER(css),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
    g_object_unref(css);

    selector->canvas = GTK_DRAWING_AREA(gtk_drawing_area_new());
    gtk_drawing_area_set_draw_func(selector->canvas, draw, selector, NULL);
    gtk_window_set_child(GTK_WINDOW(selector->window), GTK_WIDGET(selector->canvas));

    GtkEventController *keys = gtk_event_controller_key_new();
    g_signal_connect(keys, "key-pressed", G_CALLBACK(key_pressed_real), selector);
    g_signal_connect(keys, "key-released", G_CALLBACK(key_released), selector);
    gtk_widget_add_controller(GTK_WIDGET(selector->window), keys);

    GtkGesture *click = gtk_gesture_click_new();
    g_signal_connect(click, "released", G_CALLBACK(clicked), selector);
    gtk_widget_add_controller(GTK_WIDGET(selector->window), GTK_EVENT_CONTROLLER(click));
    g_signal_connect(selector->window, "close-request",
                     G_CALLBACK(close_request), selector);

    preload_nearby(selector);
    return selector;
}

static void selector_free(Selector *selector)
{
    if (selector == NULL) {
        return;
    }
    if (selector->commit_timer != 0) {
        g_source_remove(selector->commit_timer);
    }
    if (selector->thumbnail_pool != NULL) {
        g_thread_pool_free(selector->thumbnail_pool, FALSE, TRUE);
    }
    g_clear_pointer(&selector->error, g_free);
    g_clear_pointer(&selector->items, g_ptr_array_unref);
    g_clear_pointer(&selector->pixbufs, g_hash_table_unref);
    g_clear_pointer(&selector->loading, g_hash_table_unref);
    g_clear_pointer(&selector->failed, g_hash_table_unref);
    g_clear_pointer(&selector->colors, g_hash_table_unref);
    g_free(selector);
}

static void activate(GtkApplication *application, gpointer user_data)
{
    AppState *app = user_data;
    UNUSED(application);
    if (app->selector == NULL) {
        app->selector = selector_new(app);
        gtk_window_present(GTK_WINDOW(app->selector->window));
        cycle(app->selector, 1);
        return;
    }

    gtk_window_present(GTK_WINDOW(app->selector->window));
    cycle(app->selector, 1);
}

int main(int argc, char **argv)
{
    AppState app = {0};
    app.application = GTK_APPLICATION(
        gtk_application_new(APP_ID, G_APPLICATION_DEFAULT_FLAGS));
    g_signal_connect(app.application, "activate", G_CALLBACK(activate), &app);
    g_application_hold(G_APPLICATION(app.application));

    int status = g_application_run(G_APPLICATION(app.application), argc, argv);
    selector_free(app.selector);
    g_object_unref(app.application);
    return status;
}
