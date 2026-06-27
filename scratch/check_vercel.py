import os
import requests

token = os.environ.get("VERCEL_TOKEN", "YOUR_VERCEL_TOKEN")
headers = {
    "Authorization": f"Bearer {token}"
}

# List deployments
url = "https://api.vercel.com/v6/deployments"
res = requests.get(url, headers=headers, params={"limit": 5})
if res.status_code == 200:
    print("--- RECENT DEPLOYMENTS ---")
    data = res.json()
    for d in data.get("deployments", []):
        print(f"ID: {d.get('uid')}, State: {d.get('state')}, URL: {d.get('url')}, Name: {d.get('name')}, Created: {d.get('created')}")
        # Let's inspect the latest one more deeply if there is one
else:
    print(f"FAILED: Status {res.status_code}, Response: {res.text}")
