import os
from dotenv import load_dotenv
from supabase import create_client
import requests

load_dotenv(dotenv_path="parser_backend/.env")

url = os.environ.get("SUPABASE_URL")
service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
anon_key = os.environ.get("SUPABASE_ANON_KEY")

# Initialize admin client
supabase_admin = create_client(url, service_key)

print("Generating link for shrixyz28@gmail.com...")
try:
    res = supabase_admin.auth.admin.generate_link({
        "email": "shrixyz28@gmail.com",
        "type": "signup" # or login
    })
    # If the user already exists, signup link generation might fail, let's try magiclink or invitation
    print("Signup link:", res)
except Exception as e:
    print("Signup link generation failed, trying magiclink...")
    try:
        res = supabase_admin.auth.admin.generate_link({
            "email": "shrixyz28@gmail.com",
            "type": "magiclink"
        })
        print("Magiclink:", res)
    except Exception as e2:
        print("Magiclink generation failed:", e2)

# Wait, is there a simpler way? Let's just create a temporary user or sign in.
# What if we just update user's password?
# To avoid locking out the user, let's check if we can query the REST API directly using requests
# but with the Service Role key, wait, why did it succeed in python but fail in the frontend?
# Wait! In the frontend, which endpoint is it hitting?
# Let's inspect the console URL in the screenshot:
# fhejogfnroqgnhsgkzat.supabase.co/rest/v1/uncategorized_transactions?select=...&user_id=eq.ef14300d-eac0-4fc8-b868-6ce738c70b57&order=txn_date.desc&offset=0&limit=100
# Wait! Let's copy the TRANSACTIONS_SELECT from our code:
# source_account:accounts ( account_id, account_name, account_type )
# Wait, why did the server respond with 400?
# Let's send a request using Python requests with the anon_key (no auth token) to see if it returns 400!
# PostgREST query parsing errors (like invalid select fields) return 400 Bad Request, even without auth!

print("\n--- SENDING REQUEST WITH ANON KEY (NO AUTH) ---")
headers = {
    "apikey": anon_key,
    "Accept": "application/json"
}

TRANSACTIONS_SELECT = """
  uncategorized_transaction_id,
  txn_date,
  details,
  debit,
  credit,
  document_id,
  account_id,
  group_id,
  source_account:accounts ( account_id, account_name, account_type ),
  transactions!uncategorized_transaction_id (
    transaction_id,
    review_status,
    attention_level,
    offset_account_id,
    categorised_by,
    is_uncategorised,
    is_contra,
    user_note,
    accounts:offset_account_id (
      account_name,
      account_type
    )
  )
"""

res = requests.get(
    f"{url}/rest/v1/uncategorized_transactions",
    headers=headers,
    params={
        "select": TRANSACTIONS_SELECT,
        "limit": 1
    }
)
print("Status:", res.status_code)
print("Response:", res.text)
