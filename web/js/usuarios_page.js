import { apiFetch, logout, requireAuth } from "./auth.js";

const $ = (s) => document.querySelector(s);
const msg = $("#form-msg");

function setMsg(text, kind = "sys") {
  msg.textContent = text;
  msg.dataset.kind = kind;
}

async function cargar() {
  const res = await apiFetch("/usuarios");
  const users = await res.json();
  const tb = $("#tabla-users tbody");
  tb.innerHTML = "";
  for (const u of users) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${u.id}</td>
      <td><code>${u.username}</code></td>
      <td>${u.nombre}</td>
      <td>${u.rol}</td>
      <td><span class="badge" data-estado="${u.estado}">${u.estado}</span></td>
      <td class="row-actions"></td>`;
    const actions = tr.querySelector(".row-actions");

    const btnEdit = document.createElement("button");
    btnEdit.className = "btn tiny";
    btnEdit.textContent = "Editar";
    btnEdit.onclick = () => fillForm(u);
    actions.appendChild(btnEdit);

    if (u.estado === "activo" && u.username !== "ztrack") {
      const btnArch = document.createElement("button");
      btnArch.className = "btn tiny";
      btnArch.textContent = "Archivar";
      btnArch.onclick = async () => {
        if (!confirm(`¿Archivar ${u.username}?`)) return;
        await apiFetch(`/usuarios/${u.id}/archivar`, { method: "PUT", body: "{}" });
        await cargar();
      };
      actions.appendChild(btnArch);
    }
    if (u.estado === "archivado") {
      const btnAct = document.createElement("button");
      btnAct.className = "btn tiny";
      btnAct.textContent = "Activar";
      btnAct.onclick = async () => {
        await apiFetch(`/usuarios/${u.id}/activar`, { method: "PUT" });
        await cargar();
      };
      actions.appendChild(btnAct);
    }
    tb.appendChild(tr);
  }
}

function fillForm(u) {
  $("#user-id").value = u.id;
  $("#f-username").value = u.username;
  $("#f-username").disabled = true;
  $("#f-nombre").value = u.nombre;
  $("#f-email").value = u.email || "";
  $("#f-rol").value = u.rol;
  $("#f-password").value = "";
  $("#pass-hint").textContent = "(dejar vacío para no cambiar)";
  setMsg(`Editando #${u.id}`, "sys");
}

function resetForm() {
  $("#form-user").reset();
  $("#user-id").value = "";
  $("#f-username").disabled = false;
  $("#pass-hint").textContent = "(requerida al crear)";
  setMsg("", "sys");
}

$("#btn-reset")?.addEventListener("click", resetForm);
$("#btn-logout")?.addEventListener("click", () => logout());

$("#form-user")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#user-id").value;
  const payload = {
    nombre: $("#f-nombre").value.trim(),
    email: $("#f-email").value.trim() || null,
    rol: $("#f-rol").value,
  };
  const pass = $("#f-password").value;
  try {
    if (id) {
      if (pass) payload.password = pass;
      const res = await apiFetch(`/usuarios/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).detail || "Error al editar");
      setMsg("Usuario actualizado", "ok");
    } else {
      payload.username = $("#f-username").value.trim();
      payload.password = pass;
      if (!pass) throw new Error("Contraseña requerida al crear");
      const res = await apiFetch("/usuarios", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).detail || "Error al crear");
      setMsg("Usuario creado", "ok");
    }
    resetForm();
    await cargar();
  } catch (err) {
    setMsg(err.message, "err");
  }
});

const user = await requireAuth({ superOnly: true });
if (user) {
  $("#user-pill").textContent = `${user.username} · ${user.rol}`;
  await cargar();
}
