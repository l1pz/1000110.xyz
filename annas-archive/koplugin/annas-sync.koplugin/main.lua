--[[--
Anna's Archive sync for KOReader.

The phone queues a book on books.1000110.xyz; this plugin asks the server which
books are ready, writes them into the Kindle's books folder and acknowledges
them, so they show up in KOReader's file browser.

It runs when Wi-Fi connects, after a wake-up if the link is already up, or from
the menu. The device routes take `Authorization: Bearer <SYNC_TOKEN>`
(annas-archive/web/app/main.py):

    GET  /sync            {"books": [{id, title, author, filename, format, size, url}]}
    GET  /sync/files/{id} the file
    POST /sync/ack/{id}   delivered; the server stops listing it

Tested against KOReader 2025.10 (LuaJIT, Lua 5.1 syntax).
]]

local DataStorage = require("datastorage")
local InfoMessage = require("ui/widget/infomessage")
local LuaSettings = require("luasettings")
local NetworkMgr = require("ui/network/manager")
local Notification = require("ui/widget/notification")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local json = require("rapidjson")
local logger = require("logger")
local lfs = require("libs/libkoreader-lfs")
local socket = require("socket")
local socketutil = require("socketutil")
local http = require("socket.http")
local ltn12 = require("ltn12")
local _ = require("gettext")
local T = require("ffi/util").template

local DEFAULT_SERVER = "https://books.1000110.xyz"
local DEFAULT_FOLDER = "/mnt/us/books"
-- One automatic attempt a minute is plenty: FileManager and ReaderUI both hold an
-- instance, and the NetworkConnected event can arrive more than once per link.
local MIN_INTERVAL = 60
local MAX_PAGES = 10
local DOWNLOAD_BLOCK_TIMEOUT = 15
local DOWNLOAD_TOTAL_TIMEOUT = 300

-- Extensions KOReader can open; anything else gets the book's reported format.
local FORMATS = {
    epub = true, azw3 = true, mobi = true, pdf = true, fb2 = true,
    djvu = true, cbz = true, cbr = true, txt = true, html = true,
    htm = true, rtf = true, doc = true, docx = true, lit = true,
    pdb = true, prc = true, kepub = true,
}

-- Shared by every instance in this process (the module is loaded once).
local running = false
local last_attempt = 0

local AnnaSync = WidgetContainer:extend{
    is_doc_only = false,
    name = "annassync",
    settings = LuaSettings:open(DataStorage:getSettingsDir() .. "/annassync.lua"),
}

function AnnaSync:init()
    self.ui.menu:registerToMainMenu(self)
end

-- -- settings -------------------------------------------------------------

function AnnaSync:server()
    local server = self.settings:readSetting("server", DEFAULT_SERVER)
    server = (server or ""):gsub("^%s+", ""):gsub("%s+$", ""):gsub("/+$", "")
    if server == "" then
        return DEFAULT_SERVER
    end
    return server
end

function AnnaSync:token()
    return self.settings:readSetting("token", "") or ""
end

function AnnaSync:folder()
    local folder = self.settings:readSetting("folder", DEFAULT_FOLDER)
    folder = (folder or ""):gsub("^%s+", ""):gsub("%s+$", ""):gsub("/+$", "")
    if folder == "" then
        return DEFAULT_FOLDER
    end
    return folder
end

function AnnaSync:auto()
    return self.settings:readSetting("auto", true) and true or false
end

function AnnaSync:configured()
    return self:token() ~= "" and self:server():match("^https?://") ~= nil
end

function AnnaSync:set(key, value)
    value = (value or ""):gsub("^%s+", ""):gsub("%s+$", "")
    if key == "server" or key == "folder" then
        value = value:gsub("/+$", "")
    end
    self.settings:saveSetting(key, value):flush()
end

-- -- menu ----------------------------------------------------------------

function AnnaSync:addToMainMenu(menu_items)
    menu_items.annassync = {
        text = _("Könyvek (Anna's Archive)"),
        sub_item_table = {
            {
                text = _("Szinkronizálás most"),
                callback = function()
                    self:sync(true)
                end,
                separator = true,
            },
            {
                text = _("Automatikus szinkronizálás"),
                checked_func = function()
                    return self:auto()
                end,
                callback = function()
                    self.settings:saveSetting("auto", not self:auto()):flush()
                end,
            },
            {
                text_func = function()
                    return T(_("Szerver: %1"), self:server())
                end,
                keep_menu_open = true,
                tap_input_func = function()
                    return {
                        title = _("A könyvszerver címe"),
                        input = self:server(),
                        input_type = "string",
                        callback = function(input)
                            self:set("server", input)
                        end,
                    }
                end,
            },
            {
                text_func = function()
                    local token = self:token()
                    if token == "" then
                        return _("Eszköztoken: nincs beállítva")
                    end
                    return T(_("Eszköztoken: %1…"), token:sub(1, 6))
                end,
                keep_menu_open = true,
                tap_input_func = function()
                    return {
                        title = _("Eszköztoken (SYNC_TOKEN)"),
                        input = self:token(),
                        input_type = "string",
                        callback = function(input)
                            self:set("token", input)
                        end,
                    }
                end,
            },
            {
                text_func = function()
                    return T(_("Mappa: %1"), self:folder())
                end,
                keep_menu_open = true,
                tap_input_func = function()
                    return {
                        title = _("Ide kerüljenek a könyvek"),
                        input = self:folder(),
                        input_type = "string",
                        callback = function(input)
                            self:set("folder", input)
                        end,
                    }
                end,
            },
        },
    }
end

-- -- triggers ------------------------------------------------------------

function AnnaSync:onNetworkConnected()
    if not self:auto() then
        return
    end
    -- Let the link settle before the first request.
    UIManager:scheduleIn(3, function()
        self:sync(false)
    end)
end

function AnnaSync:onResume()
    if not self:auto() then
        return
    end
    UIManager:scheduleIn(5, function()
        -- Wi-Fi may reconnect later; NetworkConnected will pick that up.
        if NetworkMgr:isOnline() then
            self:sync(false)
        end
    end)
end

--- Manual sync may turn Wi-Fi on; an automatic one only uses what is already up.
function AnnaSync:sync(manual)
    if not self:configured() then
        if manual then
            UIManager:show(InfoMessage:new{
                text = _("Előbb add meg a szervert és az eszköztokent a menüben."),
            })
        end
        return
    end
    if manual then
        NetworkMgr:runWhenOnline(function()
            self:doSync(true)
        end)
    elseif NetworkMgr:isOnline() then
        self:doSync(false)
    end
end

function AnnaSync:doSync(manual)
    if running then
        return
    end
    if not manual and os.time() - last_attempt < MIN_INTERVAL then
        return
    end
    running = true
    last_attempt = os.time()

    local holder
    if manual then
        holder = { widget = InfoMessage:new{ text = _("Könyvek szinkronizálása…") } }
        UIManager:show(holder.widget)
        UIManager:forceRePaint()
    end

    local ok, downloaded, skipped, failed, reason = pcall(self.syncAll, self, holder)
    running = false
    if not ok then
        logger.err("annassync: sync crashed:", downloaded)
        downloaded, skipped, failed, reason = 0, 0, 0, _("Váratlan hiba, a részletek a crash.log-ban.")
    end
    if holder then
        UIManager:close(holder.widget)
    end
    self:report(manual, downloaded or 0, skipped or 0, failed or 0, reason)
end

-- -- work ----------------------------------------------------------------

function AnnaSync:syncAll(holder)
    local server, token, folder = self:server(), self:token(), self:folder()
    if lfs.attributes(folder, "mode") ~= "directory" then
        lfs.mkdir(folder)
    end
    if lfs.attributes(folder, "mode") ~= "directory" then
        return 0, 0, 0, T(_("Nem tudom létrehozni a mappát: %1"), folder)
    end

    local downloaded, skipped, failed = 0, 0, 0
    for _page = 1, MAX_PAGES do
        local data, reason = self:fetchList(server, token)
        if not data then
            if downloaded + skipped == 0 then
                return downloaded, skipped, failed, reason
            end
            return downloaded, skipped, failed
        end
        local books = data.books
        if type(books) ~= "table" or #books == 0 then
            break
        end

        local progressed = false
        for _index, book in ipairs(books) do
            local id = tostring(book.id or "")
            local name = tostring(book.filename or "")
            if id ~= "" and name ~= "" then
                local path = folder .. "/" .. self:safeFilename(name, book.format)
                if lfs.attributes(path, "mode") == "file" then
                    -- Already on the device, e.g. a previous ack got lost.
                    skipped = skipped + 1
                    self:ack(id)
                    progressed = true
                else
                    self:showProgress(holder, book.title or name)
                    local ok, err = self:download(self:fileUrl(server, book, id), path, token)
                    if ok then
                        downloaded = downloaded + 1
                        progressed = true
                        self:ack(id)
                    else
                        failed = failed + 1
                        logger.warn("annassync: download failed:", id, err)
                    end
                end
            else
                failed = failed + 1
                logger.warn("annassync: book without id or filename", book.id, book.filename)
            end
        end

        -- A failed book stays "ready", so asking again would retry the same file
        -- in a loop; leave it for the next sync instead.
        if not progressed or failed > 0 then
            break
        end
    end
    return downloaded, skipped, failed
end

function AnnaSync:fetchList(server, token)
    local sink = {}
    socketutil:set_timeout(15, 30)
    local code, _headers, status = socket.skip(1, http.request{
        url = server .. "/sync",
        method = "GET",
        headers = self:headers(token),
        sink = ltn12.sink.table(sink),
    })
    socketutil:reset_timeout()
    if code ~= 200 then
        logger.warn("annassync: GET /sync ->", code, status)
        return nil, self:reason(code)
    end
    local data, err = json.decode(table.concat(sink))
    if type(data) ~= "table" then
        logger.warn("annassync: GET /sync returned bad JSON:", err)
        return nil, _("Értelmezhetetlen válasz a szervertől.")
    end
    return data
end

function AnnaSync:fileUrl(server, book, id)
    local url = tostring(book.url or "")
    if url == "" then
        url = "/sync/files/" .. id
    end
    if url:match("^https?://") then
        return url
    end
    if url:sub(1, 1) ~= "/" then
        url = "/" .. url
    end
    return server .. url
end

function AnnaSync:download(url, path, token)
    local tmp = path .. ".part"
    local handle, err = io.open(tmp, "wb")
    if not handle then
        return false, err or tmp
    end
    socketutil:set_timeout(DOWNLOAD_BLOCK_TIMEOUT, DOWNLOAD_TOTAL_TIMEOUT)
    local code, _headers, status = socket.skip(1, http.request{
        url = url,
        method = "GET",
        headers = self:headers(token),
        sink = socketutil.file_sink(handle),
    })
    socketutil:reset_timeout()
    if code ~= 200 then
        -- The sink closes the handle when the request completes; on an error
        -- before the first chunk it is still open.
        pcall(function()
            handle:close()
        end)
        os.remove(tmp)
        logger.warn("annassync: download", url, "->", code, status)
        return false, self:reason(code)
    end
    local size = lfs.attributes(tmp, "size")
    if not size or size == 0 then
        os.remove(tmp)
        return false, _("üres fájl")
    end
    local renamed, rename_err = os.rename(tmp, path)
    if not renamed then
        os.remove(tmp)
        return false, rename_err
    end
    return true
end

function AnnaSync:ack(id)
    socketutil:set_timeout(15, 30)
    local code, _headers, status = socket.skip(1, http.request{
        url = self:server() .. "/sync/ack/" .. id,
        method = "POST",
        headers = {
            ["Authorization"] = "Bearer " .. self:token(),
            ["Content-Type"] = "application/json",
            ["Content-Length"] = "0",
        },
        source = ltn12.source.string(""),
    })
    socketutil:reset_timeout()
    if code ~= 200 then
        logger.warn("annassync: ack", id, "->", code, status)
        return false
    end
    return true
end

-- -- helpers -------------------------------------------------------------

function AnnaSync:headers(token)
    return {
        ["Authorization"] = "Bearer " .. token,
        ["Accept"] = "application/json",
        ["Accept-Encoding"] = "identity",
    }
end

function AnnaSync:reason(code)
    code = tonumber(code)
    if not code then
        return _("Nincs hálózati kapcsolat.")
    end
    if code == 401 or code == 403 then
        return _("Az eszköztoken nem jó.")
    end
    if code == 404 then
        return _("A szerver nem található ezen a címen.")
    end
    if code == 502 or code == 503 then
        return _("A szerver most nem érhető el.")
    end
    return T(_("A szerver hibát adott vissza (%1)."), code)
end

function AnnaSync:showProgress(holder, title)
    if not holder then
        return
    end
    UIManager:close(holder.widget)
    holder.widget = InfoMessage:new{ text = T(_("Letöltés: %1"), title) }
    UIManager:show(holder.widget)
    UIManager:forceRePaint()
end

--- FAT32-safe, human-readable name; the server's name is only a suggestion.
function AnnaSync:safeFilename(name, format)
    name = tostring(name or ""):match("[^/\\]+$") or ""
    name = name:gsub("%c", ""):gsub('[<>:"/\\|%?%*]', "_")
    name = name:gsub("^[%.%s]+", ""):gsub("[%s%.]+$", "")
    if name == "" then
        name = "könyv"
    end

    local ext = name:match("%.([%w]+)$")
    if not ext or not FORMATS[ext:lower()] then
        local suffix = tostring(format or "epub"):lower():gsub("[^%w]", "")
        if suffix == "" then
            suffix = "epub"
        end
        name = name .. "." .. suffix
    end

    if #name > 120 then
        local base, extension = name:match("^(.*)%.([%w]+)$")
        if base then
            name = base:sub(1, 110) .. "." .. extension
        else
            name = name:sub(1, 120)
        end
    end
    return name
end

function AnnaSync:report(manual, downloaded, skipped, failed, reason)
    if manual then
        local text
        if reason then
            text = reason
        elseif downloaded > 0 then
            text = T(_("%1 könyv letöltve."), downloaded)
        elseif failed > 0 then
            text = T(_("%1 könyvet nem sikerült letölteni."), failed)
        elseif skipped > 0 then
            text = _("Minden könyv megvan.")
        else
            text = _("Nincs új könyv.")
        end
        UIManager:show(InfoMessage:new{ text = text, timeout = 5 })
    elseif downloaded > 0 then
        Notification:notify(T(_("%1 új könyv a Kindle-en."), downloaded))
    elseif reason then
        logger.warn("annassync:", reason)
    end

    if downloaded > 0 and self.ui and self.ui.file_chooser then
        pcall(self.ui.file_chooser.refreshPath, self.ui.file_chooser)
    end
end

return AnnaSync