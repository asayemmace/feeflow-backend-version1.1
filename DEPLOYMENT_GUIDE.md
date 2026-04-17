# Deployment Guide: Render (Backend) + Vercel (Frontend)

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
   - `FRONTEND_URL` - Your Vercel frontend URL (e.g., `https://yourapp.vercel.app`)
   - `DATABASE_URL` - Your PostgreSQL connection string
   - `DIRECT_URL` - Your PostgreSQL direct connection string (for Prisma migrations)
   
   **Note:** You can get a free PostgreSQL database from [render.com](https://render.com) or use an external provider

4. **Deploy:**
   - Click "Deploy"
   - Once live, copy your Render backend URL (e.g., `https://feeflow-backend.onrender.com`)

---

## Frontend Deployment to Vercel

1. **Update environment variable:**
   - Update `frontend-flow/.env` with your Render backend URL:
     ```
     VITE_API_URL=https://your-backend-name.onrender.com
     ```

2. **Push to GitHub:**
   - Commit and push your code to GitHub

3. **Deploy to Vercel:**
   - Go to [vercel.com](https://vercel.com) and sign up
   - Click "Add New" → "Project"
   - Import your GitHub repository
   - Select `frontend-flow` as the root directory
   - Under "Environment Variables", add:
     - `VITE_API_URL` = Your Render backend URL

4. **Deploy:**
   - Click "Deploy"
   - Your frontend will be live at a Vercel URL

---

## Important Notes

- After deploying the backend to Render, update the `FRONTEND_URL` in Render's environment variables with your Vercel frontend URL for CORS to work correctly
- Keep your JWT_SECRET secure - generate a strong random string
- The `render.yaml` file handles the build and start commands automatically
- Both platforms offer free tiers, though they have limitations (Render free tier sleeps after 15 min of inactivity)
