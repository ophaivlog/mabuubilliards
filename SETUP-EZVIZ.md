# EZVIZ setup for Vercel

Trong Vercel, vao Project -> Settings -> Environment Variables va them:

```text
EZVIZ_API_BASE=https://isgpopen.ezvizlife.com
EZVIZ_APP_KEY=6670568989044098809731cc0e5ca93c
EZVIZ_APP_SECRET=dan_app_secret_cua_anh_vao_day
EZVIZ_EZOPEN_DOMAIN=open.ezviz.com
EZVIZ_REC_TYPE=rec
EZVIZ_CAMERA_MAP={"14":{"deviceSerial":"BF9642392","channelNo":1,"quality":1,"validCode":"WRYZOM"}}
```

Khong dua `EZVIZ_APP_SECRET` vao file public neu GitHub repo de public. Nen khai bao trong Vercel Environment Variables.

Sau khi them bien moi, bam Redeploy de Vercel build lai.
