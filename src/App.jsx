/*
Esqueleto React (single-file) para MVP: "Reconhecimento Facial - Presença"
Como usar:
1) Crie um projeto Vite React (ou CRA) e substitua App.jsx pelo conteúdo deste arquivo.
   - npm create vite@latest my-app -- --template react
   - cd my-app
   - npm install
2) Instale dependências:
   npm install face-api.js @supabase/supabase-js xlsx
3) Coloque os modelos do face-api em public/models (ou ajuste loadFromUri). Ex.:
   public/models/
     - tiny_face_detector_model-weights_manifest.json + bin
     - face_landmark_68_model-weights_manifest.json + bin
     - face_recognition_model-weights_manifest.json + bin
4) Defina variáveis de ambiente (por exemplo em .env):
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
5) Rode: npm run dev

Observação: Este arquivo é um esqueleto didático. Em produção ajuste RLS, tratamento de chaves e privacidade.
*/

import React, { useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

let faceapi;
if (typeof window !== 'undefined') {
  faceapi = await import('face-api.js');
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default function App() {
  const [route, setRoute] = useState('dashboard'); // 'login','dashboard','register','attendance','history'
  const [loadingModels, setLoadingModels] = useState(true);
  const [user, setUser] = useState(null); // simple single-account flow

  // Entities
  const [companies, setCompanies] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [selectedCompany, setSelectedCompany] = useState(null);

  // Camera / attendance
  const attendanceInterval = useRef(null);
  const videoRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [facingMode, setFacingMode] = useState('environment');
  const [statusMsg, setStatusMsg] = useState('');

  // Register form
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [capturedDescriptors, setCapturedDescriptors] = useState([]);

  // History
  const [attendances, setAttendances] = useState([]);

  useEffect(() => {
    // load face-api models
    async function loadModels() {
      const MODEL_URL = '/models';
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        setLoadingModels(false);
      } catch (err) {
        console.error('Erro carregando modelos', err);
      }
    }
    loadModels();
    // fetch companies as start
    fetchCompanies();
  }, []);

  async function fetchCompanies() {
    const { data, error } = await supabase.from('companies').select('*').order('name');
    if (error) console.error(error);
    else setCompanies(data || []);
  }

  async function fetchEmployees(companyId) {
    const { data, error } = await supabase.from('employees').select('*').eq('company_id', companyId);
    if (error) console.error(error);
    else setEmployees(data || []);
  }

  async function fetchAttendances(filters = {}) {
    let q = supabase.from('attendances').select('*,employees!inner(name)').order('attended_at', { ascending: false }).limit(1000);
    if (filters.company_id) q = q.eq('company_id', filters.company_id);
    if (filters.employee_id) q = q.eq('employee_id', filters.employee_id);
    const { data, error } = await q;
    if (error) console.error(error);
    else setAttendances(data || []);
  }

  // Simple login (single admin user) - for demo we'll skip real auth
  function loginDemo() {
    setUser({ name: 'EmpresaAdmin' });
    setRoute('dashboard');
  }

  // Camera helpers
  async function openCamera() {
    try {
      if (stream) {
        // stop previous
        stream.getTracks().forEach(t => t.stop());
      }
      const constraints = { video: { facingMode } };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      videoRef.current.srcObject = s;
      await videoRef.current.play();
      setStream(s);
      setStatusMsg('Câmera aberta');
    } catch (err) {
      console.error('Erro abrir câmera', err);
      setStatusMsg('Erro ao abrir câmera: ' + String(err));
    }
  }

  function switchFacing() {
    setFacingMode(prev => (prev === 'user' ? 'environment' : 'user'));
    // reopen camera after state change
    setTimeout(() => openCamera(), 300);
  }

  // Capture descriptors (for registration)
  async function captureDescriptorFromVideo() {
    if (!videoRef.current) return null;
    const options = new faceapi.TinyFaceDetectorOptions();
    const detection = await faceapi
      .detectSingleFace(videoRef.current, options)
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!detection) return null;
    return Array.from(detection.descriptor);
  }

  async function handleCaptureForRegister() {
    setStatusMsg('Capturando...');
    const desc = await captureDescriptorFromVideo();
    if (!desc) {
      setStatusMsg('Nenhum rosto detectado. Tente novamente.');
      return;
    }
    setCapturedDescriptors(prev => [...prev, desc]);
    setStatusMsg('Captura realizada. Total: ' + (capturedDescriptors.length + 1));
  }

  async function saveNewEmployee() {
    if (!selectedCompany) { alert('Selecione uma empresa'); return; }
    if (!newName) { alert('Nome é obrigatório'); return; }
    if (capturedDescriptors.length === 0) { alert('Capte ao menos 1 foto'); return; }
    const payload = {
      company_id: selectedCompany,
      name: newName,
      role: newRole,
      descriptors: capturedDescriptors,
      photos: []
    };
    const { data, error } = await supabase.from('employees').insert([payload]);
    if (error) {
      console.error(error);
      alert('Erro ao salvar funcionário');
    } else {
      alert('Funcionário salvo');
      setNewName(''); setNewRole(''); setCapturedDescriptors([]);
      fetchEmployees(selectedCompany);
      setRoute('dashboard');
    }
  }

 async function startAttendanceLoop() {
  if (!selectedCompany) { 
    setStatusMsg('Selecione uma empresa primeiro');
    return; 
  }

  const { data: emps } = await supabase
    .from('employees')
    .select('*')
    .eq('company_id', selectedCompany);

  if (!emps?.length) {
    setStatusMsg('Nenhum funcionário cadastrado');
    return;
  }

  const labeled = emps.map(e => 
    new faceapi.LabeledFaceDescriptors(
      e.id.toString(), 
      (e.descriptors || []).map(d => new Float32Array(d))
    )
  );

  const faceMatcher = new faceapi.FaceMatcher(labeled, 0.55);

  setStatusMsg('🔄 Reconhecimento contínuo iniciado...');

  // se já tinha loop rodando, para
  if (attendanceInterval.current) clearInterval(attendanceInterval.current);

  attendanceInterval.current = setInterval(async () => {
    const options = new faceapi.TinyFaceDetectorOptions();
    const detection = await faceapi
      .detectSingleFace(videoRef.current, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (detection) {
      const best = faceMatcher.findBestMatch(detection.descriptor);

      if (best.label !== 'unknown') {
        const confidence = best.distance;
        const matchedEmployeeId = best.label;

        // evita duplicação em menos de 5 minutos
        const now = new Date();
        const { data: last } = await supabase
          .from('attendances')
          .select('*')
          .eq('employee_id', matchedEmployeeId)
          .order('attended_at', { ascending: false })
          .limit(1);

        if (!last.length || new Date(last[0].attended_at) < now - 20*1000) {
          await supabase.from('attendances').insert([{
            company_id: selectedCompany,
            employee_id: matchedEmployeeId,
            confidence
          }]);

          setStatusMsg(`✅ Presença registrada: ${matchedEmployeeId} (conf: ${confidence.toFixed(2)})`);
        } else {
          setStatusMsg(`⚠️ ${matchedEmployeeId} já registrado recentemente`);
        }
      }
    }
  }, 300); // roda a cada 3s
}

function stopAttendanceLoop() {
  if (attendanceInterval.current) clearInterval(attendanceInterval.current);
  setStatusMsg('⏹️ Reconhecimento parado');
}

  function exportAttendancesToExcel() {
    if (!attendances || attendances.length === 0) { alert('Sem registros'); return; }
    // normalize
    const rows = attendances.map(r => ({ id: r.id, employee: r.employees?.name || r.employee_id, attended_at: r.attended_at, confidence: r.confidence }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Presencas');
    XLSX.writeFile(wb, 'presencas.xlsx');
  }

  // UI
  return (
    <div className="min-h-screen bg-gray-50 p-4 font-sans">
      <header className="max-w-3xl mx-auto mb-6">
        <h1 className="text-2xl font-bold">MVP - Presença Facial</h1>
        <p className="text-sm text-gray-600">Modelos carregados: {loadingModels ? 'carregando...' : 'pronto'}</p>
      </header>

      {!user ? (
        <div className="max-w-md mx-auto bg-white p-4 rounded shadow">
          <h2 className="text-lg">Login (demo)</h2>
          <button className="mt-4 px-4 py-2 bg-blue-600 text-white rounded" onClick={loginDemo}>Entrar como demo</button>
        </div>
      ) : (
        <main className="max-w-4xl mx-auto">
          <nav className="mb-4 flex gap-2">
            <button className={`px-3 py-2 rounded ${route==='dashboard' ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={()=>setRoute('dashboard')}>Dashboard</button>
            <button className={`px-3 py-2 rounded ${route==='register' ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={()=>{ setRoute('register'); fetchCompanies(); }}>Registrar Funcionário</button>
            <button className={`px-3 py-2 rounded ${route==='attendance' ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={()=>{ setRoute('attendance'); }}>Tela de Presença</button>
            <button className={`px-3 py-2 rounded ${route==='history' ? 'bg-blue-600 text-white' : 'bg-white'}`} onClick={()=>{ setRoute('history'); fetchAttendances({ company_id: selectedCompany }); }}>Histórico</button>
          </nav>

          {route === 'dashboard' && (
            <section className="bg-white p-4 rounded shadow">
              <h2 className="text-lg font-semibold">Dashboard</h2>
              <p className="mt-2">Selecione a empresa para operar:</p>
              <select className="mt-2 p-2 border" value={selectedCompany || ''} onChange={e=>{ setSelectedCompany(e.target.value); fetchEmployees(e.target.value); }}>
                <option value="">-- selecione --</option>
                {companies.map(c=> <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div className="mt-4">
                <p>Funcionários cadastrados: {employees.length}</p>
                <p>Registros: {attendances.length}</p>
              </div>
            </section>
          )}

          {route === 'register' && (
            <section className="bg-white p-4 rounded shadow">
              <h2 className="text-lg font-semibold">Registrar Funcionário</h2>
              <div className="mt-2">
                <label>Empresa</label>
                <select className="block p-2 border" value={selectedCompany || ''} onChange={e=>{ setSelectedCompany(e.target.value); fetchEmployees(e.target.value); }}>
                  <option value="">-- selecione --</option>
                  {companies.map(c=> <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="mt-2">
                <label>Nome</label>
                <input className="block p-2 border w-full" value={newName} onChange={e=>setNewName(e.target.value)} />
                <label className="mt-2">Cargo</label>
                <input className="block p-2 border w-full" value={newRole} onChange={e=>setNewRole(e.target.value)} />
              </div>
              <div className="mt-3">
                <div className="flex gap-2 items-center">
                  <button className="px-3 py-2 bg-green-600 text-white rounded" onClick={openCamera}>Abrir Câmera</button>
                  <button className="px-3 py-2 bg-yellow-500 text-white rounded" onClick={switchFacing}>Trocar Frente/Trás</button>
                  <button className="px-3 py-2 bg-indigo-600 text-white rounded" onClick={handleCaptureForRegister}>Capturar Rostos</button>
                </div>
                <video ref={videoRef} className="w-full mt-2 rounded border" autoPlay muted playsInline style={{maxHeight:300}} />
                <p className="mt-2 text-sm">Capturas: {capturedDescriptors.length}</p>
                <div className="mt-2">
                  <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={saveNewEmployee}>Salvar Funcionário</button>
                </div>
              </div>
            </section>
          )}

          {route === 'attendance' && (
            <section className="bg-white p-4 rounded shadow">
              <h2 className="text-lg font-semibold">Tela de Presença</h2>
              <p className="mt-2">Empresa: {companies.find(c=>c.id===selectedCompany)?.name || 'nenhuma selecionada'}</p>
              <div className="flex gap-2 mt-2">
                <button className="px-3 py-2 bg-green-600 text-white rounded" onClick={openCamera}>Abrir Câmera</button>
                <button className="px-3 py-2 bg-purple-600 text-white rounded" onClick={startAttendanceLoop}>Iniciar Reconhecimento</button>
                <button className="px-3 py-2 bg-red-600 text-white rounded" onClick={stopAttendanceLoop}>Parar</button>
                <button className="px-3 py-2 bg-yellow-500 text-white rounded" onClick={switchFacing}>Trocar Câmera</button>
              </div>

              <video ref={videoRef} className="w-full mt-2 rounded border" autoPlay muted playsInline style={{maxHeight:360}} />
              <p className="mt-2 text-sm">Status: {statusMsg}</p>
            </section>
          )}

          {route === 'history' && (
            <section className="bg-white p-4 rounded shadow">
              <h2 className="text-lg font-semibold">Histórico</h2>
              <div className="mt-2 flex gap-2">
                <button className="px-3 py-2 bg-gray-200 rounded" onClick={()=>fetchAttendances({ company_id: selectedCompany })}>Carregar</button>
                <button className="px-3 py-2 bg-blue-600 text-white rounded" onClick={exportAttendancesToExcel}>Exportar XLSX</button>
              </div>
              <div className="mt-4 overflow-auto max-h-96">
                <table className="w-full text-sm">
                  <thead className="bg-gray-100"><tr><th>ID</th><th>Funcionário</th><th>Quando</th><th>Confiança</th></tr></thead>
                  <tbody>
                    {attendances.map(a => (
                      <tr key={a.id} className="border-t"><td className="p-1">{a.id.slice(0,6)}</td><td className="p-1">{a.employees?.name || a.employee_id}</td><td className="p-1">{new Date(a.attended_at).toLocaleString()}</td><td className="p-1">{a.confidence}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

        </main>
      )}

      <footer className="max-w-3xl mx-auto mt-6 text-sm text-gray-500">Feito como esqueleto. Ajuste permissões Supabase e LGPD antes de usar em produção.</footer>
    </div>
  );
}
