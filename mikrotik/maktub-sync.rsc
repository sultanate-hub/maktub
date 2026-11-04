# =====================================================================
# Maktub — router -> dashboard sync (chunked)
# ---------------------------------------------------------------------
# Sends used vouchers (active now OR with a Mikhmon expiry comment) plus
# the active-session list. Chunks of 150 users keep each request small
# enough for RouterOS fetch even on 1,000+ user routers.
#
# Unused vouchers are skipped, exactly like the London/Alimu rule: a
# voucher appears on the dashboard after its first login.
#
# INSTALL (per router):
#   1. Edit apiKey below with THAT network's key.
#   2. Create script "maktub-sync" from this file, run once.
#   3. Scheduler every 2m.
# =====================================================================

:local apiKey "REPLACE_WITH_NETWORK_API_KEY"
:local apiUrl "https://zmolotveyvkplfrgrqqw.supabase.co/functions/v1/maktub/api/mikhmon-sync"
:local chunkSize 150

:local act "|"
:local actLines ""
:foreach a in=[/ip hotspot active find] do={
    :local au [/ip hotspot active get $a user]
    :if ([:len $au] > 0) do={
        :set act ($act . $au . "|")
        :set actLines ($actLines . "A|" . $au . "\n")
    }
}

:local buf ""
:local count 0
:local sent 0
:foreach i in=[/ip hotspot user find] do={
    :local name [/ip hotspot user get $i name]
    :local com  [/ip hotspot user get $i comment]
    :local isActive false
    :if ([:typeof [:find $act ("|" . $name . "|")]] != "nil") do={ :set isActive true }
    :if (($isActive = true) or ([:len $com] > 0)) do={
        :local pass [/ip hotspot user get $i password]
        :local prof [/ip hotspot user get $i profile]
        :local mac  [/ip hotspot user get $i mac-address]
        :local dis  [/ip hotspot user get $i disabled]
        :local lim  [/ip hotspot user get $i limit-uptime]
        :local up   [/ip hotspot user get $i uptime]
        :set buf ($buf . "U|" . $name . "|" . $pass . "|" . $prof . "|" . $mac . "|" . $dis . "|" . $lim . "|" . $up . "|" . $com . "\n")
        :set count ($count + 1)
        :if ($count >= $chunkSize) do={
            :do {
                /tool fetch url=$apiUrl mode=https check-certificate=no http-method=post \
                    http-header-field="Content-Type:text/plain,x-api-key:$apiKey" \
                    http-data=($buf . $actLines . "F|1\n") keep-result=no
                :set sent ($sent + $count)
            } on-error={
                :log warning "MAKTUB-SYNC: chunk upload failed"
            }
            :set buf ""
            :set count 0
        }
    }
}
:if ([:len $buf] > 0) do={
    :do {
        /tool fetch url=$apiUrl mode=https check-certificate=no http-method=post \
            http-header-field="Content-Type:text/plain,x-api-key:$apiKey" \
            http-data=($buf . $actLines . "F|1\n") keep-result=no
        :set sent ($sent + $count)
    } on-error={
        :log warning "MAKTUB-SYNC: final chunk upload failed"
    }
}
:log info ("MAKTUB-SYNC: sent " . $sent . " users")
