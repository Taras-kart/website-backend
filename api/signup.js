import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const { name, email, password } = req.body;
  const usersFile = path.join(process.cwd(), 'data', 'users.json');

  if (!existsSync(path.dirname(usersFile))) mkdirSync(path.dirname(usersFile));

  let users = [];
  if (existsSync(usersFile)) {
    users = JSON.parse(require('fs').readFileSync(usersFile, 'utf-8'));
  }

  const existing = users.find(u => u.email === email);
  if (existing) return res.status(400).json({ message: 'User already exists' });

  const user = {
    id: users.length + 1,
    name,
    email,
    password,
    type: 'B2C',
    created_at: new Date(),
    updated_at: new Date()
  };

  users.push(user);
  writeFileSync(usersFile, JSON.stringify(users, null, 2));
  res.status(201).json({ message: 'User created', user });
}
