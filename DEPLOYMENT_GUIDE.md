# Deployment Guide: Render (Backend) + Netlify (Frontend)

## Backend Deployment to Render

1. **Prepare the backend:**
   - Push your code to GitHub (Render deploys from GitHub)
   - Ensure `render.yaml` is in the root of `backend-flow` folder

2. **Create Render service:**
   - Go to [render.com](https://render.com) and sign up
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Select the `backend-flow` folder as the root directory
   - Render will auto-detect `render.yaml`

3. **Set Environment Variables in Render Dashboard:**
   - `JWT_SECRET` - Use a strong secret key
   - `FRONTEND_URL` - Your Netlify frontend URL (e.g., `https://yourapp.netlify.app`)
   - `DATABASE_URL` - Your PostgreSQL connection string
   - `DIRECT_URL` - Your PostgreSQL direct connection string (for Prisma migrations)
   - `ALLOWED_ORIGINS` - Comma-separated frontend origins:
     `https://www.feeflowafrica.co.ke,https://feeflowafrica.co.ke,https://asayfeeflow.onrender.com,http://localhost:5173,http://localhost:3000`
   - `SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key for server-side Storage uploads
   - `SUPABASE_STORAGE_BUCKET` - `school-logos`
   
   **Note:** You can get a free PostgreSQL database from [render.com](https://render.com) or use an external provider
   Create a public Supabase Storage bucket named `school-logos` before uploading school logos. If you see `Bucket not found` in the backend logs, the bucket is missing or `SUPABASE_STORAGE_BUCKET` points to a different name. The backend will try to create the bucket automatically with the service role key, but you can also create it manually in Supabase Dashboard -> Storage -> New bucket -> `school-logos` -> Public bucket.

4. **Migrate the database before/while deploying:**
   - Local/dev database:
     ```
     cd backend-flow
     npx prisma migrate dev --name add_invoice_snapshot_fields
     npx prisma generate
     ```
   - Production/Supabase database:
     ```
     cd backend-flow
     npx prisma migrate deploy
     npx prisma generate
     ```
   - Confirm the `Invoice` table has:
     `accountTotalCharges`, `totalPaidToDate`, `totalDueNow`, `newChargesTotal`, `previousOutstanding`.
   - Do not run `prisma migrate reset` on Supabase/production.

5. **Deploy:**
   - Click "Deploy"
   - Once live, copy your Render backend URL (e.g., `https://feeflow-backend.onrender.com`)

---

## Frontend Deployment to Netlify

1. **Update environment variable:**
   - Update `frontend-flow/.env` with your Render backend URL:
     ```
     VITE_API_URL=https://your-backend-name.onrender.com
     ```

2. **Push to GitHub:**
   - Commit and push your code to GitHub

3. **Deploy to Netlify:**
   - Go to [netlify.com](https://netlify.com) and sign up
   - Click "Add new site" → "Import from Git"
   - Import your GitHub repository
   - Select `frontend-flow` as the base directory
   - Under "Build settings", set:
     - `Build command` = `npm run build`
     - `Publish directory` = `dist`
   - Under "Environment variables", add:
     - `VITE_API_URL` = Your Render backend URL

4. **Deploy:**
   - Click "Deploy"
   - Your frontend will be live at a Netlify URL

---

## Important Notes

- After deploying the backend to Render, update the `FRONTEND_URL` in Render's environment variables with your Netlify frontend URL for CORS to work correctly
- Keep your JWT_SECRET secure - generate a strong random string
- The `render.yaml` file handles the build and start commands automatically
- Both platforms offer free tiers, though they have limitations (Render free tier sleeps after 15 min of inactivity)

//push to github
# 1. Stage all changes (from both frontend and backend)
git add .

# 2. Label your update
git commit -m "Update: [Describe what you changed here]"

# 3. Send to GitHub
git push origin main
or
git push origin main --force
or
function ship { git add .; git commit -m "update"; git push origin main }
ship
