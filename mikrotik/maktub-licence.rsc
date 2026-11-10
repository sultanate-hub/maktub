# =====================================================================
# Maktub - licence enforcement (no grace period) with maintenance page
# ---------------------------------------------------------------------
# Polls the licence endpoint once a minute.
#
#   licence due  -> clients get the maintenance page with the support
#                   numbers, hotspot logins are switched off and browsing
#                   is blocked. Nobody can log in or use the hotspot until
#                   the licence is renewed.
#   licence paid -> the normal login page and login methods are restored
#                   and the block is removed automatically.
#
# FAIL-OPEN on network errors: a cloud outage never locks the network.
# Only an explicit "active":false from the server locks it.
#
# INSTALL (per router):
#   1. Edit apiKey below (the network key printed by tools/add-network.js).
#   2. Save as script "maktub-licence" and run once.
#   3. /system scheduler add name=maktub-licence interval=1m \
#        on-event="/system script run maktub-licence"
#
# The maintenance page is downloaded automatically to
# hotspot/maint/login.html (the folder is created by /tool fetch).
# =====================================================================

:local apiKey "REPLACE_WITH_NETWORK_API_KEY"
:local apiUrl "https://zmolotveyvkplfrgrqqw.supabase.co/functions/v1/maktub/api/licence"
:local hotspotServer "hs-bridge-LAN"
:local hotspotProfile "hs-profile"
:local loginBy "cookie,http-chap"
:local loginDir "hotspot"
:local maintDir "hotspot/maint"
:local maintUrl "https://maktub.dreamhatcher.ink/maint"
:local lockComment "MAKTUB-LICENCE-LOCK"

:local answer ""
:do {
    /tool fetch url=$apiUrl mode=https check-certificate=no \
        http-header-field="x-api-key:$apiKey" dst-path=maktub-lic.txt
    :set answer [/file get maktub-lic.txt contents]
    /file remove maktub-lic.txt
} on-error={
    :log warning "MAKTUB-LIC: fetch failed - leaving hotspot as is (fail-open)"
    :return ""
}

:local isActive false
:if ([:typeof [:find $answer "\"active\":true"]] != "nil") do={ :set isActive true }
:if ([:typeof [:find $answer "\"active\":false"]] != "nil") do={ :set isActive false }

:local hs [/ip hotspot find name=$hotspotServer]
:if ([:len $hs] = 0) do={
    :log error "MAKTUB-LIC: hotspot server not found: $hotspotServer"
    :return ""
}
:local prof [/ip hotspot profile find name=$hotspotProfile]
:if ([:len $prof] = 0) do={
    :log error "MAKTUB-LIC: hotspot profile not found: $hotspotProfile"
    :return ""
}

# Lock rule: drops forwarded traffic from the hotspot LAN, so the portal
# (traffic to the router) still loads but no client can browse.
:local rule [/ip firewall filter find where comment=$lockComment]
:if ([:len $rule] = 0) do={
    /ip firewall filter add chain=forward in-interface=bridge-LAN action=drop \
        comment=$lockComment
    :set rule [/ip firewall filter find where comment=$lockComment]
}

:local curDir [/ip hotspot profile get $prof html-directory]
:local curLoginBy [/ip hotspot profile get $prof login-by]
:local hsDisabled [/ip hotspot get $hs disabled]

:if ($isActive = false) do={
    # Make sure the maintenance page and its redirect file are on flash.
    :foreach name in={"login.html";"redirect.html"} do={
        :local path ($maintDir . "/" . $name)
        :local file [/file find name=$path]
        :local size 0
        :if ([:len $file] > 0) do={ :set size [/file get $file size] }
        :if ($size < 50) do={
            :do {
                /tool fetch url=($maintUrl . "/" . $name) mode=https check-certificate=no \
                    dst-path=$path
                :log info ("MAKTUB-LIC: downloaded " . $name)
            } on-error={
                :log warning ("MAKTUB-LIC: could not download " . $name)
            }
        }
    }
    :local page [/file find name=($maintDir . "/login.html")]
    :local pageSize 0
    :if ([:len $page] > 0) do={ :set pageSize [/file get $page size] }
    # Never swap to an empty page - keep the login page if the download failed.
    :if (($pageSize >= 1000) and ($curDir != $maintDir)) do={
        /ip hotspot profile set $prof html-directory=$maintDir
        # Kick every session so devices actually land on the maintenance page.
        /ip hotspot active remove [/ip hotspot active find]
        /ip hotspot cookie remove [/ip hotspot cookie find]
        :log warning "MAKTUB-LIC: subscription due - maintenance page active"
    }
    # No login method while due: even a valid voucher cannot authenticate,
    # whatever order the firewall rules end up in.
    :if ($curLoginBy != "") do={
        /ip hotspot profile set $prof login-by=""
        :log warning "MAKTUB-LIC: hotspot logins disabled while due"
    }
    :if ($hsDisabled = true) do={ /ip hotspot enable $hs }
    /ip firewall filter set $rule disabled=no
}

:if ($isActive = true) do={
    /ip firewall filter set $rule disabled=yes
    :if ($curLoginBy != $loginBy) do={
        /ip hotspot profile set $prof login-by=$loginBy
        :log warning "MAKTUB-LIC: hotspot logins restored"
    }
    :if ($curDir != $loginDir) do={
        /ip hotspot profile set $prof html-directory=$loginDir
        :log warning "MAKTUB-LIC: subscription active - normal login restored"
    }
    :if ($hsDisabled = true) do={ /ip hotspot enable $hs }
}
